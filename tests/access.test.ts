import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { Comment, Person, Project, Session, Task } from "../shared/api.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

const AUDIENCE = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid: randomBytes(16).toString("hex"), privateKey, publicKey };
}

/** A Cloudflare Access team domain: its keys at /cdn-cgi/access/certs, and tokens signed with them. */
class FakeAccess {
  readonly url: string;
  private readonly server: Server;
  /** The keys the team domain publishes. */
  readonly keys: SigningKey[];

  private constructor(url: string, server: Server, keys: SigningKey[]) {
    this.url = url;
    this.server = server;
    this.keys = keys;
  }

  static async start(): Promise<FakeAccess> {
    const keys = [signingKey()];
    const server = createServer((req, res) => {
      if (req.url !== "/cdn-cgi/access/certs") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: keys.map((key) => ({ ...key.publicKey.export({ format: "jwk" }), kid: key.kid, alg: "RS256", use: "sig" })) }));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return new FakeAccess(`http://127.0.0.1:${port}`, server, keys);
  }

  /** A token as Cloudflare Access issues one for `email`; `claims` and `key` change it. */
  token(email: string, claims: Record<string, unknown> = {}, key: SigningKey = this.keys[0]): string {
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = encode({ alg: "RS256", kid: key.kid, typ: "JWT" });
    const body = encode({ aud: [AUDIENCE], email, exp: now + 3_600, iat: now, nbf: now, iss: this.url, type: "app", sub: email, ...claims });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
  }

  stop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    return promise;
  }
}

let access: FakeAccess;
let gateway: Gateway;
let chrome: Browser;
let configDir: string;
let project: Project;
let mia: Person;

/** The header Cloudflare's edge sets on every request it lets through the tunnel. */
function edge(token: string): Record<string, string> {
  return { "cf-access-jwt-assertion": token };
}

before(async () => {
  buildApp();
  access = await FakeAccess.start();
  configDir = mkdtempSync(join(tmpdir(), "am-access-config-"));
  mkdirSync(join(configDir, "cloudflare"));
  writeFileSync(join(configDir, "cloudflare", "draftcoach.env"), "CLOUDFLARE_READ_TOKEN=read-7c1e\nCLOUDFLARE_WRITE_TOKEN=write-9d2f\n");
  [gateway, chrome] = await Promise.all([
    Gateway.start({
      runtime: "none",
      env: {
        AGENTMONITOR_AUTH_MODE: "access",
        AGENTMONITOR_ACCESS_TEAM_DOMAIN: access.url,
        AGENTMONITOR_ACCESS_AUD: AUDIENCE,
        AGENTMONITOR_OWNER_EMAIL: "Armin@Example.com",
        AGENTMONITOR_CONFIG_DIR: configDir,
      },
    }),
    chromium.launch(),
  ]);
  const owner = edge(access.token("armin@example.com"));
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach", hostSessions: true }, owner);
  mia = await gateway.data<Person>("POST", "/people", { name: "Mia Wong", email: "mia@example.com" }, owner);
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
  await access?.stop();
  if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
});

const ownerToken = () => access.token("armin@example.com");

/** A request to a session's Tern host, as the browser sends it; with `upgrade`, the chat's socket. */
function tern(sessionId: string, headers: Record<string, string>, upgrade = false): Promise<number> {
  const { port } = new URL(gateway.url);
  const host = `tern-${sessionId}.localhost:${port}`;
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const sent = request({
    host: "127.0.0.1",
    port,
    path: upgrade ? "/wire" : "/",
    headers: {
      host,
      ...(upgrade
        ? { connection: "Upgrade", upgrade: "websocket", origin: `http://${host}`, "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") }
        : {}),
      ...headers,
    },
  });
  sent.on("response", (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  sent.on("upgrade", (response, socket) => {
    socket.destroy();
    resolve(response.statusCode ?? 0);
  });
  sent.on("error", reject);
  sent.end();
  return promise;
}

spec("AUTH-1", "the hub's API, app, and session hosts refuse requests without a valid Cloudflare Access token for the hub", async () => {
  const owner = edge(ownerToken());
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Patch notes 26.21" }, owner);
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {}, owner);

  // A valid token, in Cloudflare's header or its cookie, reaches the API, the app, and the
  // session's host (whose Tern does not run without containers).
  assert.equal((await gateway.api("GET", "/projects", undefined, owner)).status, 200);
  assert.equal((await gateway.api("GET", "/projects", undefined, { cookie: `theme=dark; CF_Authorization=${ownerToken()}` })).status, 200);
  assert.equal((await fetch(gateway.url, { headers: owner })).status, 200);
  assert.equal(await tern(session.id, owner), 409);
  assert.equal(await tern(session.id, owner, true), 409);

  // Keys Cloudflare rotates in are fetched when a token names one.
  const rotated = signingKey();
  access.keys.push(rotated);
  assert.equal((await gateway.api("GET", "/projects", undefined, edge(access.token("armin@example.com", {}, rotated)))).status, 200);

  const now = Math.floor(Date.now() / 1_000);
  const forged = { ...signingKey(), kid: access.keys[0].kid };
  const refused: Array<[string, Record<string, string>]> = [
    ["no token", {}],
    ["not a token", edge("not-a-token")],
    ["a token signed with another key under the hub's key id", edge(access.token("armin@example.com", {}, forged))],
    ["an expired token", edge(access.token("armin@example.com", { exp: now - 60, iat: now - 3_660, nbf: now - 3_660 }))],
    ["a token for another application", edge(access.token("armin@example.com", { aud: ["0b9f2f6c1a5d4e3b8c7a6f5e4d3c2b1a"] }))],
    ["a token from another team", edge(access.token("armin@example.com", { iss: "https://elsewhere.cloudflareaccess.com" }))],
    ["a token signed with a key the team does not publish", edge(access.token("armin@example.com", {}, signingKey()))],
  ];
  for (const [what, headers] of refused) {
    const api = await gateway.api("GET", "/projects", undefined, headers);
    assert.equal(api.status, 401, `the API refuses ${what}: ${api.body.error}`);
    const app = await fetch(gateway.url, { headers });
    assert.equal(app.status, 401, `the app refuses ${what}`);
    assert.match(await app.text(), /Refused: /);
    assert.equal(await tern(session.id, headers), 401, `the session's host refuses ${what}`);
    assert.equal(await tern(session.id, headers, true), 401, `the session's socket refuses ${what}`);
  }
});

spec("AUTH-2", "a person logs in with their email and acts as themselves; an email that is no person of the store is refused", async () => {
  const owner = edge(ownerToken());
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Leaderboard filters" }, owner);

  // Emails compare regardless of case, so a second Mia is refused.
  assert.equal((await gateway.api("POST", "/people", { name: "Mia", email: "MIA@example.com" }, owner)).status, 409);
  const me = await gateway.data<{ person: Person }>("GET", "/me", undefined, edge(access.token("Mia@Example.com")));
  assert.equal(me.person.id, mia.id);

  // Mia comments from the task's page, logged in through Access's cookie, and the comment is hers.
  const context = await chrome.newContext();
  try {
    await context.addCookies([{ name: "CF_Authorization", value: access.token("mia@example.com"), url: gateway.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${gateway.url}/#/t/${target.id}`);
    const comments = page.getByRole("region", { name: "Comments" });
    await comments.getByRole("textbox", { name: "Comment", exact: true }).fill("Filters ship with **26.22**");
    await comments.getByRole("button", { name: "Comment", exact: true }).click();
    const shown = comments.locator(".comment");
    await shown.locator("strong", { hasText: "26.22" }).waitFor();
    assert.equal(await shown.locator(".actor-name").textContent(), "Mia Wong");
    const stored = await gateway.data<Comment[]>("GET", `/tasks/${target.id}/comments`, undefined, owner);
    assert.deepEqual(stored.map((comment) => comment.author), [{ kind: "person", personId: mia.id }]);

    // Someone Access lets in who is no person of the store gets a page saying so, and no data.
    const stranger = edge(access.token("eve@example.com"));
    const refused = await gateway.api("GET", "/projects", undefined, stranger);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error ?? "", /eve@example\.com is not a person of this hub/);
    await context.clearCookies();
    await context.addCookies([{ name: "CF_Authorization", value: access.token("eve@example.com"), url: gateway.url }]);
    const opened = await page.goto(gateway.url);
    assert.equal(opened?.status(), 403);
    await page.getByText("eve@example.com is not a person of this hub").waitFor();
  } finally {
    await context.close();
  }
});

spec("AUTH-3", "every person works on all the hub's projects; only its owner adds people, starts host sessions, and allows Cloudflare writes", async () => {
  const owner = edge(ownerToken());
  const asMia = edge(access.token("mia@example.com"));

  // Mia sees the owner's project and works in it: tasks, comments, topics, sessions.
  assert.deepEqual((await gateway.data<Project[]>("GET", "/projects", undefined, asMia)).map((listed) => listed.id), [project.id]);
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Ads rotation" }, asMia);
  await gateway.data("POST", `/tasks/${target.id}/comments`, { body: "Starting on it" }, asMia);
  await gateway.data("POST", `/projects/${project.id}/topics`, { name: "Ads" }, asMia);
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, { runtime: "container" }, asMia);

  // What only the owner does.
  const hostTask = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Server logs" }, asMia);
  const checkoutTask = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Merge slices" }, asMia);
  const refusals: Array<[string, Promise<{ status: number }>]> = [
    ["add a person", gateway.api("POST", "/people", { name: "Jogi", email: "jogi@example.com" }, asMia)],
    ["start a host session", gateway.api("POST", `/tasks/${hostTask.id}/sessions`, { runtime: "host" }, asMia)],
    ["start a session in the main checkout", gateway.api("POST", `/tasks/${checkoutTask.id}/sessions`, { runtime: "host", checkout: true }, asMia)],
    ["allow Cloudflare writes", gateway.api("POST", `/sessions/${session.id}/cloudflare-writes`, undefined, asMia)],
  ];
  for (const [what, refused] of refusals) assert.equal((await refused).status, 403, `Mia may not ${what}`);
  assert.equal((await gateway.data<Person[]>("GET", "/people", undefined, owner)).length, 2);

  await gateway.data<Person>("POST", "/people", { name: "Jogi", email: "jogi@example.com" }, owner);
  const host = await gateway.data<Session>("POST", `/tasks/${hostTask.id}/sessions`, { runtime: "host" }, owner);
  assert.equal(host.runtime, "host");
  const allowed = await gateway.data<{ writesUntil: number }>("POST", `/sessions/${session.id}/cloudflare-writes`, undefined, owner);
  assert.ok(allowed.writesUntil > Date.now());

  // Mia ends the session she started.
  await gateway.data("POST", `/sessions/${session.id}/end`, {}, asMia);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { Comment, Person, Project, Session, Task } from "../shared/api.ts";
import { AUDIENCE, FakeAccess, signingKey } from "./fake-access.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

let access: FakeAccess;
let gateway: Gateway;
let chrome: Browser;
let project: Project;
let mia: Person;

/** The header Cloudflare's edge sets on every request it lets through the tunnel. */
function edge(token: string): Record<string, string> {
  return { "cf-access-jwt-assertion": token };
}

before(async () => {
  await buildApp();
  access = await FakeAccess.start();
  [gateway, chrome] = await Promise.all([
    Gateway.start({
      runtime: "none",
      hub: true,
      env: {
        AGENTMONITOR_AUTH_MODE: "access",
        AGENTMONITOR_ACCESS_TEAM_DOMAIN: access.url,
        AGENTMONITOR_ACCESS_AUD: AUDIENCE,
        AGENTMONITOR_OWNER_EMAIL: "Armin@Example.com",
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
});

const ownerToken = () => access.token("armin@example.com");

/**
 * A request on `host` (a label under `localhost`), as the browser sends it: a page, or with
 * `origin` the WebSocket upgrade a page on that origin makes. The status: 101 for an opened socket.
 */
function onHost(label: string, path: string, headers: Record<string, string>, origin?: string): Promise<number> {
  const { port } = new URL(gateway.url);
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const sent = request({
    host: "127.0.0.1",
    port,
    path,
    headers: {
      host: `${label}.localhost:${port}`,
      ...(origin === undefined
        ? {}
        : { connection: "Upgrade", upgrade: "websocket", origin, "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") }),
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

/** CHAT-1: opens the session's chat socket on the hub's UI host as the app's page does (from the UI's origin unless `origin` says another). */
function chatSocket(session: Session, headers: Record<string, string>, origin = gateway.url): Promise<number> {
  return onHost("am", `/api/store/sessions/${session.id}/chat`, headers, origin);
}

spec("AUTH-1", "the hub's API, app, chat sockets, and previews refuse requests without a valid Cloudflare Access token for the hub", async () => {
  const owner = edge(ownerToken());
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Patch notes 26.21" }, owner);
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {}, owner);

  // A valid token, in Cloudflare's header or its cookie, reaches the API, the app, the
  // session's chat socket, and the task's preview host.
  assert.equal((await gateway.api("GET", "/projects", undefined, owner)).status, 200);
  assert.equal((await gateway.api("GET", "/projects", undefined, { cookie: `theme=dark; CF_Authorization=${ownerToken()}` })).status, 200);
  assert.equal((await fetch(gateway.url, { headers: owner })).status, 200);
  assert.equal(await chatSocket(session, owner), 101);
  assert.equal(await onHost(`am-p-${target.id}`, "/", owner), 404);

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
    assert.equal(await chatSocket(session, headers), 401, `the session's chat socket refuses ${what}`);
    assert.equal(await onHost(`am-p-${target.id}`, "/", headers), 401, `the task's preview host refuses ${what}`);
  }
});

spec("CHAT-1", "only people who may see the session's project open its chat, and only from the UI's own pages", async () => {
  const owner = edge(ownerToken());
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Chat access" }, owner);
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {}, owner);
  // Every person of the hub sees its projects (AUTH-3).
  assert.equal(await chatSocket(session, edge(access.token("mia@example.com"))), 101);
  // Someone Access lets in who is no person of the store does not.
  assert.equal(await chatSocket(session, edge(access.token("eve@example.com"))), 403);
  // Another site open in the owner's browser cannot drive the session.
  assert.equal(await chatSocket(session, owner, "https://elsewhere.example"), 403);
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
  await gateway.data("PUT", `/projects/${project.id}/cloudflare`, { read: "read-7c1e", write: "write-9d2f" }, owner);
  const allowed = await gateway.data<{ writesUntil: number }>("POST", `/sessions/${session.id}/cloudflare-writes`, undefined, owner);
  assert.ok(allowed.writesUntil > Date.now());

  // Mia ends the session she started.
  await gateway.data("POST", `/sessions/${session.id}/end`, {}, asMia);
});

/** A store API request of a session's agent, through its socket; the status and the answer's text. */
function asAgent(session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const sent = request({
    socketPath: join(gateway.stateDir, "sessions", session.id, "run", "am.sock"),
    method,
    path: `/api/store${path}`,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
  });
  sent.on("error", reject);
  sent.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

spec("CLOUDFLARE-3", "the owner sets a project's Cloudflare tokens in its settings; no page, answer, or agent shows them again, and nobody else sets them", async () => {
  const owner = edge(ownerToken());
  const asMia = edge(access.token("mia@example.com"));
  const read = `cf-read-${randomBytes(8).toString("hex")}`;
  const write = `cf-write-${randomBytes(8).toString("hex")}`;
  const target = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Bracket site" }, owner);
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {}, owner);
  const flags = async (headers: Record<string, string>) =>
    (await gateway.data<Project[]>("GET", "/projects", undefined, headers)).find((listed) => listed.id === project.id)?.cloudflare;
  // The project starts without tokens (AUTH-3 set some).
  await gateway.data("DELETE", `/projects/${project.id}/cloudflare`, undefined, owner);

  // Everything the store answers the owner's page, the tokens' own request included.
  const answers: Array<Promise<string>> = [];
  const context = await chrome.newContext();
  try {
    await context.addCookies([{ name: "CF_Authorization", value: ownerToken(), url: gateway.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/")) answers.push(response.text().catch(() => ""));
    });
    await page.goto(`${gateway.url}/#/project`);
    const section = page.getByRole("form", { name: "Cloudflare" });
    await section.getByText("No Cloudflare tokens.").waitFor();
    await section.getByLabel("Read token").fill(read);
    await section.getByLabel("Write token (optional)").fill(write);
    await section.getByRole("button", { name: "Save" }).click();
    await section.getByRole("status").getByText("Saved.").waitFor();
    await section.getByText("Read token set. Write token set.").waitFor();
    assert.deepEqual([await section.getByLabel("Read token").inputValue(), await section.getByLabel("Write token (optional)").inputValue()], ["", ""]);
    await page.reload();
    await section.getByText("Read token set. Write token set.").waitFor();
    const html = await page.content();
    assert.ok(!html.includes(read) && !html.includes(write), "the settings page shows a token");
    assert.deepEqual(await flags(owner), { read: true, write: true });

    // Mia sees that they are set, without the fields, and the store refuses her setting or removing them.
    const miaContext = await chrome.newContext();
    try {
      await miaContext.addCookies([{ name: "CF_Authorization", value: access.token("mia@example.com"), url: gateway.url }]);
      const miaPage = await miaContext.newPage();
      miaPage.setDefaultTimeout(10_000);
      await miaPage.goto(`${gateway.url}/#/project`);
      const miaSection = miaPage.getByRole("form", { name: "Cloudflare" });
      await miaSection.getByText("Read token set. Write token set.").waitFor();
      await miaSection.getByText("Only the store's owner sets the project's Cloudflare tokens.").waitFor();
      assert.equal(await miaSection.getByLabel("Read token").count(), 0);
    } finally {
      await miaContext.close();
    }
    assert.equal((await gateway.api("PUT", `/projects/${project.id}/cloudflare`, { read: "cf-read-mia" }, asMia)).status, 403);
    assert.equal((await gateway.api("DELETE", `/projects/${project.id}/cloudflare`, undefined, asMia)).status, 403);
    assert.deepEqual(await flags(owner), { read: true, write: true });

    // The session's agent reads that they are set, and cannot set them either.
    const agentView = await asAgent(session, "GET", "/projects");
    assert.equal(agentView.status, 200);
    assert.ok(!agentView.text.includes(read) && !agentView.text.includes(write), "the agent's answer holds a token");
    assert.equal((await asAgent(session, "PUT", `/projects/${project.id}/cloudflare`, { read: "cf-read-agent" })).status, 403);
    const shown = gateway.am(session.id, ["project", "show"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^cloudflare read token set, write token set$/m);

    // A read token alone: the agents only read. Then the owner removes the tokens.
    await section.getByLabel("Read token").fill(read);
    await section.getByRole("button", { name: "Save" }).click();
    await section.getByText("Read token set. No write token: agents only read.").waitFor();
    assert.deepEqual(await flags(owner), { read: true, write: false });
    await section.getByRole("button", { name: "Remove" }).click();
    await section.getByText("No Cloudflare tokens.").waitFor();
    assert.deepEqual(await flags(owner), { read: false, write: false });
    const answered = await Promise.all(answers);
    assert.ok(answered.some((text) => text.includes(`"cloudflare":{"read":true,"write":true}`)), "the page read the project's tokens being set");
    assert.ok(!answered.some((text) => text.includes(read) || text.includes(write)), "the store answered with a token");
  } finally {
    await context.close();
  }
  await gateway.data("POST", `/sessions/${session.id}/end`, {}, owner);
});

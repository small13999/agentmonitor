import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { Comment, FolderFile, Person, Project, Session, StoreListing, Task, TaskDetail } from "../shared/api.ts";
import { AUDIENCE, FakeAccess } from "./fake-access.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

/** The hub's owner, as Cloudflare Access names them. */
const OWNER = "armin@example.com";

/**
 * Cloudflare's edge in front of a hub, at the hub's public origin (`am.<zone>`, here
 * `am.localhost:<port>`): it turns the client's `cf-access-token` into the
 * `Cf-Access-Jwt-Assertion` the hub checks, passes the public Host on, and answers 502 when the
 * hub behind it is down. It keeps every token it saw. The hub starts after it, knowing its origin,
 * and is set as `hub`.
 */
async function startEdge(): Promise<{ url: string; tokens: string[]; hub: string | null; close: () => void }> {
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    const token = request.headers["cf-access-token"];
    tokens.push(typeof token === "string" ? token : "");
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "cf-access-token"));
    headers["cf-access-jwt-assertion"] = token;
    assert.ok(edge.hub !== null);
    const forwarded = httpRequest(new URL(request.url ?? "/", edge.hub), { method: request.method, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    forwarded.on("error", () => {
      response.writeHead(502, "Bad Gateway", { "content-type": "text/html" });
      response.end("<h1>502 Bad Gateway</h1>");
    });
    request.pipe(forwarded);
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  // am.localhost resolves to ::1 or 127.0.0.1; both reach a dual-stack socket.
  server.listen(0, "::", () => resolve());
  await promise;
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  const edge: { url: string; tokens: string[]; hub: string | null; close: () => void } = {
    url: `http://am.localhost:${address.port}`,
    tokens,
    hub: null,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
  return edge;
}

/**
 * A hub in Access mode behind its edge, and a client whose hubs.json names it twice, once with
 * the owner's token and once with the token of someone who is no person of the hub, and a hub it
 * cannot get a token for.
 */
async function hubAndClient() {
  const edge = await startEdge();
  const hub = await Gateway.start({
    runtime: "none",
    env: {
      AGENTMONITOR_AUTH_MODE: "access",
      AGENTMONITOR_ACCESS_TEAM_DOMAIN: access.url,
      AGENTMONITOR_ACCESS_AUD: AUDIENCE,
      AGENTMONITOR_OWNER_EMAIL: OWNER,
      AGENTMONITOR_PUBLIC_ORIGIN: edge.url,
    },
  });
  edge.hub = hub.url;
  const ownerToken = access.token(OWNER);
  const strangerToken = access.token("eve@example.com");
  const configDir = mkdtempSync(join(tmpdir(), "am-client-config-"));
  writeFileSync(join(configDir, "hubs.json"), JSON.stringify([
    { name: "draftcoach", url: edge.url, tokenCommand: ["echo", ownerToken] },
    { name: "stranger", url: edge.url, tokenCommand: ["echo", strangerToken] },
    { name: "broken", url: "http://127.0.0.1:9", tokenCommand: ["sh", "-c", "echo 'not logged in' >&2; exit 1"] },
  ]));
  const client = await Gateway.start({ runtime: "none", env: { AGENTMONITOR_CONFIG_DIR: configDir } });
  stops.push(() => client.stop(), () => hub.stop(), async () => edge.close());
  /** What the test sends the hub itself, through its edge as the owner from the hub's UI. */
  const onHub = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${edge.url}/api/store${path}`, {
      method,
      headers: { "cf-access-token": ownerToken, origin: edge.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const answer = await response.json() as { ok: boolean; data: T; error?: string };
    if (!answer.ok) throw new Error(`${method} ${path} -> ${response.status} ${answer.error}`);
    return answer.data;
  };
  /** The client's store API of hub `draftcoach`, as the app calls it. */
  const viaClient = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; ok: boolean; data: T; error?: string }> => {
    const response = await fetch(`${client.url}/api/hubs/draftcoach/store${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() as { ok: boolean; data: T; error?: string } };
  };
  const stores = async (): Promise<StoreListing[]> => {
    const response = await fetch(`${client.url}/api/stores`);
    return (await response.json() as { data: StoreListing[] }).data;
  };
  return { hub, edge, client, viaClient, stores, onHub, ownerToken, strangerToken };
}

const stops: Array<() => Promise<void>> = [];
let chrome: Browser;
let access: FakeAccess;

before(async () => {
  await buildApp();
  [chrome, access] = await Promise.all([chromium.launch(), FakeAccess.start()]);
});
after(async () => {
  await chrome?.close();
  await access?.stop();
  for (const stop of stops) await stop();
});

spec("STORE-3", "a client lists its hubs' projects beside its own, shows a hub project as the hub's site does, and marks an unreachable hub unavailable", async () => {
  const { hub, edge, client, viaClient, stores, onHub, ownerToken, strangerToken } = await hubAndClient();
  const local = await client.data<Project>("POST", "/projects", { name: "agentmonitor" });
  const project = await onHub<Project>("POST", "/projects", { name: "draftcoach" });
  const task = await onHub<Task>("POST", `/projects/${project.id}/tasks`, { title: "Patch notes 26.21", description: "Translate the **JP** notes." });
  await onHub("POST", `/tasks/${task.id}/comments`, { body: "Notes are in the folder." });
  const owner = (await onHub<{ person: Person }>("GET", "/me")).person;

  // Both stores' projects; a hub that refuses the token, or gives none, says why.
  const listed = await stores();
  assert.deepEqual(listed.map((store) => [store.hub, store.projects.map((candidate) => candidate.id), store.unavailable]), [
    [null, [local.id], null],
    ["draftcoach", [project.id], null],
    ["stranger", [], "the hub answered 403: eve@example.com is not a person of this hub: ask its owner to add you"],
    ["broken", [], "token command failed: not logged in"],
  ]);

  const page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${client.url}/#/t`);
  const picker = page.getByRole("combobox", { name: "Project" });
  await picker.waitFor();
  assert.deepEqual(
    await picker.locator("optgroup").evaluateAll((groups) => groups.map((group) => [group.getAttribute("label"), [...group.querySelectorAll("option")].map((option) => option.textContent)])),
    [
      ["Agent Monitor", ["agentmonitor"]],
      ["draftcoach", ["draftcoach"]],
      ["stranger (unavailable)", ["Unavailable: the hub answered 403: eve@example.com is not a person of this hub: ask its owner to add you"]],
      ["broken (unavailable)", ["Unavailable: token command failed: not logged in"]],
    ],
  );

  // The hub's project: its board and its task's page, with the hub's data.
  await picker.selectOption(project.id);
  const board = page.getByRole("region", { name: "Board" });
  await board.getByRole("article", { name: "Patch notes 26.21" }).click();
  await page.waitForURL(new RegExp(`#/t/${task.id}$`));
  await page.locator("strong", { hasText: "JP" }).waitFor();
  const comments = page.getByRole("region", { name: "Comments" });
  await comments.locator(".comment", { hasText: "Notes are in the folder." }).waitFor();

  // A comment written in the client is the hub's, by the person the token names.
  await comments.getByRole("textbox", { name: "Comment", exact: true }).fill("Ship **after** QA");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await comments.locator(".comment strong", { hasText: "after" }).waitFor();
  const written = await onHub<Comment[]>("GET", `/tasks/${task.id}/comments`);
  assert.deepEqual(written.map((comment) => [comment.author, comment.body]), [
    [{ kind: "person", personId: owner.id }, "Notes are in the folder."],
    [{ kind: "person", personId: owner.id }, "Ship **after** QA"],
  ]);

  // A folder's file goes to the hub and comes back as bytes.
  const uploaded = await fetch(`${client.url}/api/hubs/draftcoach/store/tasks/${task.id}/folder/notes/jp.txt`, { method: "PUT", body: "パッチノート" });
  assert.equal(uploaded.status, 200);
  assert.deepEqual((await onHub<FolderFile[]>("GET", `/tasks/${task.id}/folder`)).map((file) => file.path), ["notes/jp.txt"]);
  const downloaded = await fetch(`${client.url}/api/hubs/draftcoach/store/tasks/${task.id}/folder/notes/jp.txt`);
  assert.equal(await downloaded.text(), "パッチノート");
  assert.equal((await viaClient<TaskDetail>("GET", `/tasks/${task.id}`)).data.task.title, "Patch notes 26.21");

  // Every request reached the hub with a token of the client's hubs.json, which the hub checked.
  assert.deepEqual(new Set(edge.tokens), new Set([ownerToken, strangerToken]));

  // A stopped hub is unavailable, with why; its project stays listed and says so.
  await hub.stop();
  const down = (await stores()).find((store) => store.hub === "draftcoach");
  assert.deepEqual([down?.projects.map((candidate) => candidate.id), down?.unavailable], [[project.id], "the hub answered 502 Bad Gateway"]);
  // A new page load asks again at once, instead of at the list's next poll.
  await page.reload();
  await picker.locator("optgroup[label='draftcoach (unavailable)'] option", { hasText: "Unavailable: the hub answered 502 Bad Gateway" }).waitFor({ state: "attached" });
  await page.getByText("hub draftcoach is unavailable: the hub answered 502 Bad Gateway").first().waitFor();
  await page.close();
});

spec("STORE-4", "starting a session in a hub project starts it on the hub, and fails naming the hub when it is unreachable", async () => {
  const { hub, viaClient, onHub } = await hubAndClient();
  const project = await onHub<Project>("POST", "/projects", { name: "draftcoach" });
  const first = await onHub<Task>("POST", `/projects/${project.id}/tasks`, { title: "Leaderboard" });
  const second = await onHub<Task>("POST", `/projects/${project.id}/tasks`, { title: "Client fixes" });

  const started = await viaClient<Session>("POST", `/tasks/${first.id}/sessions`, {});
  assert.equal(started.ok, true, started.error ?? "");
  assert.deepEqual((await onHub<Session[]>("GET", `/projects/${project.id}/sessions`)).map((session) => session.id), [started.data.id]);

  await hub.stop();
  const refused = await viaClient<Session>("POST", `/tasks/${second.id}/sessions`, {});
  assert.equal(refused.status, 502);
  assert.equal(refused.error, "hub draftcoach is unavailable: the hub answered 502 Bad Gateway");
});

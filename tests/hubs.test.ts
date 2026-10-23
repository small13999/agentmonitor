import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { Comment, FolderFile, Project, Session, StoreListing, Task, TaskDetail } from "../shared/api.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

const TOKEN = "hub-access-token";

/**
 * Cloudflare's edge in front of a hub: it turns the client's `cf-access-token` into the
 * `Cf-Access-Jwt-Assertion` the hub checks, and answers 502 when the hub behind it is down.
 * It keeps every token it saw.
 */
async function startEdge(origin: string): Promise<{ url: string; tokens: string[]; close: () => void }> {
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    const token = request.headers["cf-access-token"];
    tokens.push(typeof token === "string" ? token : "");
    const headers: IncomingHttpHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== "cf-access-token"));
    headers["cf-access-jwt-assertion"] = token;
    const forwarded = httpRequest(new URL(request.url ?? "/", origin), { method: request.method, headers }, (answer) => {
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
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    tokens,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** A hub in local mode behind its edge, and a client whose hubs.json names it and a hub it cannot get a token for. */
async function hubAndClient() {
  const hub = await Gateway.start();
  const edge = await startEdge(hub.url);
  const configDir = mkdtempSync(join(tmpdir(), "am-client-config-"));
  writeFileSync(join(configDir, "hubs.json"), JSON.stringify([
    { name: "draftcoach", url: edge.url, tokenCommand: ["echo", TOKEN] },
    { name: "broken", url: "http://127.0.0.1:9", tokenCommand: ["sh", "-c", "echo 'not logged in' >&2; exit 1"] },
  ]));
  const client = await Gateway.start({ runtime: "none", env: { AGENTMONITOR_CONFIG_DIR: configDir } });
  stops.push(() => client.stop(), () => hub.stop(), async () => edge.close());
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
  return { hub, edge, client, viaClient, stores };
}

const stops: Array<() => Promise<void>> = [];
let chrome: Browser;

before(async () => {
  buildApp();
  chrome = await chromium.launch();
});
after(async () => {
  await chrome?.close();
  for (const stop of stops) await stop();
});

spec("STORE-3", "a client lists its hubs' projects beside its own, shows a hub project as the hub's site does, and marks an unreachable hub unavailable", async () => {
  const { hub, edge, client, viaClient, stores } = await hubAndClient();
  const local = await client.data<Project>("POST", "/projects", { name: "agentmonitor" });
  const project = await hub.data<Project>("POST", "/projects", { name: "draftcoach" });
  const task = await hub.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Patch notes 26.21", description: "Translate the **JP** notes." });
  await hub.data("POST", `/tasks/${task.id}/comments`, { body: "Notes are in the folder." });

  // Both stores' projects; the hub that gives no token says why.
  const listed = await stores();
  assert.deepEqual(listed.map((store) => [store.hub, store.projects.map((candidate) => candidate.id), store.unavailable]), [
    [null, [local.id], null],
    ["draftcoach", [project.id], null],
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

  // A comment written in the client is the hub's.
  await comments.getByRole("textbox", { name: "Comment", exact: true }).fill("Ship **after** QA");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await comments.locator(".comment strong", { hasText: "after" }).waitFor();
  assert.deepEqual((await hub.data<Comment[]>("GET", `/tasks/${task.id}/comments`)).map((comment) => comment.body), ["Notes are in the folder.", "Ship **after** QA"]);

  // A folder's file goes to the hub and comes back as bytes.
  const uploaded = await fetch(`${client.url}/api/hubs/draftcoach/store/tasks/${task.id}/folder/notes/jp.txt`, { method: "PUT", body: "パッチノート" });
  assert.equal(uploaded.status, 200);
  assert.deepEqual((await hub.data<FolderFile[]>("GET", `/tasks/${task.id}/folder`)).map((file) => file.path), ["notes/jp.txt"]);
  const downloaded = await fetch(`${client.url}/api/hubs/draftcoach/store/tasks/${task.id}/folder/notes/jp.txt`);
  assert.equal(await downloaded.text(), "パッチノート");
  assert.equal((await viaClient<TaskDetail>("GET", `/tasks/${task.id}`)).data.task.title, "Patch notes 26.21");

  // Every request reached the hub with the client's token.
  assert.ok(edge.tokens.length > 0);
  assert.deepEqual([...new Set(edge.tokens)], [TOKEN]);

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
  const { hub, viaClient } = await hubAndClient();
  const project = await hub.data<Project>("POST", "/projects", { name: "draftcoach" });
  const first = await hub.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Leaderboard" });
  const second = await hub.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Client fixes" });

  const started = await viaClient<Session>("POST", `/tasks/${first.id}/sessions`, {});
  assert.equal(started.ok, true, started.error ?? "");
  assert.deepEqual((await hub.data<Session[]>("GET", `/projects/${project.id}/sessions`)).map((session) => session.id), [started.data.id]);

  await hub.stop();
  const refused = await viaClient<Session>("POST", `/tasks/${second.id}/sessions`, {});
  assert.equal(refused.status, 502);
  assert.equal(refused.error, "hub draftcoach is unavailable: the hub answered 502 Bad Gateway");
});

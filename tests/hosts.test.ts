import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildApp, Gateway, Tunnel } from "./harness.ts";
import { spec } from "./spec.ts";

const ZONE = "draftcoach.gg";
const UI = `https://am.${ZONE}`;
const SECRET = "the hub's login secret";

let secretDir: string;
let gateway: Gateway;
let tunnel: Tunnel;
let chrome: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  buildApp();
  secretDir = mkdtempSync(join(tmpdir(), "am-secret-"));
  writeFileSync(join(secretDir, "secret"), SECRET, { mode: 0o600 });
  gateway = await Gateway.start({
    runtime: "none",
    env: { AGENTMONITOR_AUTH_MODE: "remote-cookie", AGENTMONITOR_PUBLIC_ORIGIN: UI, AGENTMONITOR_LOGIN_SECRET_FILE: join(secretDir, "secret") },
  });
  tunnel = await Tunnel.start(gateway);
  chrome = await chromium.launch({ args: tunnel.chromeArgs(ZONE) });
  context = await chrome.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(10_000);
  page = await context.newPage();
});
after(async () => {
  await chrome?.close();
  await tunnel?.stop();
  await gateway?.stop();
  if (secretDir !== undefined) rmSync(secretDir, { recursive: true, force: true });
});

/** A store request of the UI's own page, as the app makes it; returns the response's data. */
function store(method: string, path: string, body?: unknown): Promise<unknown> {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(`/api/store${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${method} ${path} -> ${response.status} ${result.error}`);
    return result.data;
  }, { method, path, body });
}

async function created(path: string, body: unknown): Promise<string> {
  const data = await store("POST", path, body);
  assert.ok(typeof data === "object" && data !== null && "id" in data && typeof data.id === "string");
  return data.id;
}

spec("PREVIEW-2", "the UI, a session's chat, and a task's preview each answer on their own host under the hub's zone, and only the UI gets its login cookie", async () => {
  // The UI answers on the hub's own host; logging in there sets its cookie for that host alone.
  await page.goto(`${UI}/`);
  await page.getByLabel("Login secret").fill(SECRET);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByLabel("Login secret").waitFor({ state: "detached" });
  assert.deepEqual((await context.cookies()).map((cookie) => [cookie.name, cookie.domain]), [["__Host-agentmonitor", `am.${ZONE}`]]);

  const projectId = await created("/projects", { name: "draftcoach" });
  const taskId = await created(`/projects/${projectId}/tasks`, { title: "Hosts" });

  // The chat of the session the task's Chat tab starts loads from the session's own host. The
  // app loaded before the project existed, so it loads again.
  await page.goto(`${UI}/#/t/${taskId}/chat`);
  await page.reload();
  await page.getByRole("region", { name: "Start session" }).getByRole("button", { name: "Start session" }).click();
  const detail = await store("GET", `/tasks/${taskId}`);
  assert.ok(typeof detail === "object" && detail !== null && "sessions" in detail && Array.isArray(detail.sessions));
  const [session] = detail.sessions;
  assert.ok(typeof session === "object" && session !== null && "id" in session && typeof session.id === "string");
  const chatOrigin = `https://am-t-${session.id}.${ZONE}`;
  const frame = await (await page.locator("iframe.session-frame.current").elementHandle())?.contentFrame();
  assert.ok(frame);
  await frame.waitForURL(`${chatOrigin}/`);
  assert.equal(await frame.evaluate(() => location.origin), chatOrigin);

  // The task's preview host answers on its own origin; there is no preview yet.
  const previewOrigin = `https://am-p-${taskId}.${ZONE}`;
  const preview = await context.newPage();
  const answer = await preview.goto(`${previewOrigin}/`);
  assert.equal(answer?.status(), 404);
  assert.equal(await preview.locator("body").textContent(), "This task has no preview yet.");
  assert.equal(await preview.evaluate(() => location.origin), previewOrigin);

  // The browser keeps the UI's cookie from the chat's and the preview's hosts.
  assert.deepEqual(await context.cookies([chatOrigin, previewOrigin]), []);

  // A page on the preview's host is another origin of the same site, so the browser sends the
  // UI's cookie along to the UI's host: the hub takes it as logged in (no 401) and still refuses
  // to change the store for that page.
  const forged = preview.waitForResponse(`${UI}/api/store/projects`);
  await preview.evaluate(async (ui) => {
    await fetch(`${ui}/api/store/projects`, { method: "POST", mode: "no-cors", credentials: "include", body: JSON.stringify({ name: "from-preview" }) });
  }, UI);
  assert.equal((await forged).status(), 403);
  const projects = await store("GET", "/projects");
  assert.ok(Array.isArray(projects));
  assert.deepEqual(projects.map((project) => typeof project === "object" && project !== null && "name" in project ? project.name : null), ["draftcoach"]);
});

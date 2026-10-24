import assert from "node:assert/strict";
import { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AUDIENCE, FakeAccess } from "./fake-access.ts";
import { buildApp, Gateway, Tunnel } from "./harness.ts";
import { spec } from "./spec.ts";

const ZONE = "draftcoach.gg";
const UI = `https://am.${ZONE}`;

let access: FakeAccess;
let gateway: Gateway;
let tunnel: Tunnel;
let chrome: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  await buildApp();
  access = await FakeAccess.start();
  gateway = await Gateway.start({
    runtime: "none",
    env: {
      AGENTMONITOR_AUTH_MODE: "access",
      AGENTMONITOR_ACCESS_TEAM_DOMAIN: access.url,
      AGENTMONITOR_ACCESS_AUD: AUDIENCE,
      AGENTMONITOR_OWNER_EMAIL: "armin@example.com",
      AGENTMONITOR_PUBLIC_ORIGIN: UI,
    },
  });
  // The owner has signed in through Access, whose edge adds its token to each request.
  tunnel = await Tunnel.start(gateway, () => ({ "cf-access-jwt-assertion": access.token("armin@example.com") }));
  chrome = await chromium.launch({ args: tunnel.chromeArgs(ZONE) });
  context = await chrome.newContext({ ignoreHTTPSErrors: true });
  context.setDefaultTimeout(10_000);
  page = await context.newPage();
});
after(async () => {
  await chrome?.close();
  await tunnel?.stop();
  await gateway?.stop();
  await access?.stop();
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

spec("PREVIEW-2", "the UI and a task's preview each answer on their own origin under the hub's zone, and neither acts for the other", async () => {
  // The UI answers on the hub's own host.
  await page.goto(`${UI}/`);
  const projectId = await created("/projects", { name: "draftcoach" });
  const taskId = await created(`/projects/${projectId}/tasks`, { title: "Hosts" });

  // The task's preview host answers on its own origin; with no running session it has no preview.
  const previewOrigin = `https://am-p-${taskId}.${ZONE}`;
  const preview = await context.newPage();
  const answer = await preview.goto(`${previewOrigin}/`);
  assert.equal(answer?.status(), 404);
  assert.match(await preview.locator("body").textContent() ?? "", /The task has no running session, so it has no preview/);
  assert.equal(await preview.evaluate(() => location.origin), previewOrigin);

  // The hub sets no cookie, so no host shares one with another.
  assert.deepEqual(await context.cookies(), []);

  // A page on the preview's host is another origin of the same site, and Access lets the
  // person's requests through from it: the hub knows the person (no 401) and still refuses to
  // change the store for that page.
  const forged = preview.waitForResponse(`${UI}/api/store/projects`);
  await preview.evaluate(async (ui) => {
    await fetch(`${ui}/api/store/projects`, { method: "POST", mode: "no-cors", credentials: "include", body: JSON.stringify({ name: "from-preview" }) });
  }, UI);
  assert.equal((await forged).status(), 403);
  const projects = await store("GET", "/projects");
  assert.ok(Array.isArray(projects));
  assert.deepEqual(projects.map((project) => typeof project === "object" && project !== null && "name" in project ? project.name : null), ["draftcoach"]);

  // Hosts that are not the hub's get neither the app nor its API.
  const stranger = await preview.goto(`https://elsewhere.${ZONE}/api/store/projects`);
  assert.equal(stranger?.status(), 404);
});

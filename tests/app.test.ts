import assert from "node:assert/strict";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Project, Session, Task } from "../shared/api.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

let gateway: Gateway;
let chrome: Browser;
let page: Page;
let project: Project;

before(async () => {
  buildApp();
  [gateway, chrome] = await Promise.all([Gateway.start(), chromium.launch()]);
  page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
});

function task(title: string): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title });
}

function start(target: Task): Promise<Session> {
  return gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {});
}

spec("UI-1", "the Tasks page lists open and in-progress tasks beside the workspace", async () => {
  const jp = await task("26.21 JP");
  const en = await task("26.21 EN");
  await start(jp);

  await page.goto(`${gateway.url}/#/t`);
  await page.getByRole("link", { name: "Agent Monitor" }).waitFor();
  const menus = page.getByRole("navigation", { name: "Menus" });
  assert.deepEqual(await menus.getByRole("link").allTextContents(), ["Board", "Tasks"]);
  assert.equal(await menus.getByRole("link", { name: "Tasks" }).getAttribute("aria-current"), "page");
  // Tasks keep the order they were created in, with or without a session.
  const list = page.getByRole("navigation", { name: "Tasks" });
  const listed = () => list.locator(".task-link").allTextContents();
  await list.getByRole("link", { name: /26\.21 EN/ }).waitFor();
  assert.deepEqual(await listed(), ["26.21 JP", "26.21 EN"]);

  // The list follows new and finished tasks while the page stays open.
  await task("Client fixes");
  await gateway.data("POST", `/tasks/${en.id}/finish`, { state: "done" });
  await list.getByRole("link", { name: /Client fixes/ }).waitFor();
  await list.getByRole("link", { name: /26\.21 EN/ }).waitFor({ state: "detached" });
  assert.deepEqual(await listed(), ["26.21 JP", "Client fixes"]);

  // Choosing one opens it in the workspace, on its page.
  await list.getByRole("link", { name: /26\.21 JP/ }).click();
  await page.waitForURL(new RegExp(`#/t/${jp.id}$`));
  assert.equal(await page.getByRole("tab", { name: "Page" }).getAttribute("aria-selected"), "true");
});

spec("UI-2", "a task has Page, Chat, and Settings tabs, Settings at the right with its subtabs, and switching keeps the chat loaded", async () => {
  const target = await task("Workspace tabs");
  await page.goto(`${gateway.url}/#/t/${target.id}/chat`);
  const tabs = page.getByRole("tablist", { name: "Workspace" });
  await tabs.getByRole("tab", { name: "Chat" }).waitFor();
  assert.deepEqual((await tabs.getByRole("tab").allTextContents()).map((text) => text.trim()), ["Page", "Chat", "Settings"]);
  // Settings sits at the right end of the tabs, apart from the others.
  const [bar, chatTab, settingsTab] = await Promise.all([tabs.boundingBox(), tabs.getByRole("tab", { name: "Chat" }).boundingBox(), tabs.getByRole("tab", { name: "Settings" }).boundingBox()]);
  assert.ok(bar && chatTab && settingsTab);
  assert.ok(Math.abs(settingsTab.x + settingsTab.width - (bar.x + bar.width)) <= 2, "Settings ends where the tabs end");
  assert.ok(settingsTab.x > chatTab.x + chatTab.width + 100, "Settings stands apart from Page and Chat");

  // Without a session, the Chat tab starts one.
  await page.getByRole("region", { name: "Start session" }).getByRole("button", { name: "Start session" }).click();
  const chat = page.locator("iframe.session-frame.current");
  await chat.waitFor();
  await page.getByRole("region", { name: "Start session" }).waitFor({ state: "detached" });
  const { sessions } = await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${target.id}`);
  assert.equal(sessions.length, 1);

  // Mark the chat's frame and count its loads: the other tabs must neither replace nor reload it.
  await chat.evaluate((frame) => frame.setAttribute("data-mark", "kept"));
  const ternHost = `tern-${sessions[0].id}.localhost`;
  let loads = 0;
  page.on("framenavigated", (frame) => { if (frame.url().includes(ternHost)) loads++; });
  await tabs.getByRole("tab", { name: "Page" }).click();
  await page.waitForURL(new RegExp(`#/t/${target.id}$`));
  await page.getByRole("article", { name: "Task page" }).waitFor();
  await chat.waitFor({ state: "hidden" });
  await tabs.getByRole("tab", { name: "Settings" }).click();
  await page.waitForURL(new RegExp(`#/t/${target.id}/settings$`));
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.getByRole("tab", { name: "Changes" }).waitFor();
  assert.deepEqual(await settings.getByRole("tablist", { name: "Settings" }).getByRole("tab").allTextContents(), ["Changes", "Cloudflare", "End session"]);
  await settings.getByRole("region", { name: "Changes" }).getByText("The task has no branch yet", { exact: false }).waitFor();
  await settings.getByRole("tab", { name: "Cloudflare" }).click();
  await settings.getByRole("region", { name: "Cloudflare" }).waitFor();
  await settings.getByRole("tab", { name: "End session" }).click();
  await settings.getByRole("region", { name: "End session" }).getByRole("button", { name: "End session" }).waitFor();
  await chat.waitFor({ state: "hidden" });
  await tabs.getByRole("tab", { name: "Chat" }).click();
  await chat.waitFor({ state: "visible" });
  await settings.waitFor({ state: "detached" });
  assert.equal(await chat.getAttribute("data-mark"), "kept");
  assert.equal(loads, 0);
});

spec("UI-3", "the project menu creates a project from its name, repository, and whether it allows host sessions", async () => {
  await page.goto(`${gateway.url}/#/t`);
  const menu = page.getByRole("navigation", { name: "Tasks" }).getByRole("combobox", { name: "Project" });
  await menu.selectOption({ label: "+ Project" });
  const form = page.getByRole("form", { name: "New project" });
  await form.getByRole("textbox", { name: "Name" }).fill("agentmonitor");
  await form.getByRole("textbox", { name: "Repository" }).fill("/home/you/projects/agentmonitor");
  await form.getByRole("checkbox", { name: /Allow host sessions/ }).check();
  await form.getByRole("button", { name: "Create project" }).click();

  // The new project is the one shown, and it allows host sessions; the earlier one does not.
  await page.getByRole("region", { name: "Board" }).waitFor();
  const projects = await gateway.data<Project[]>("GET", "/projects");
  const created = projects.find((candidate) => candidate.name === "agentmonitor");
  assert.deepEqual(created && { repoPath: created.repoPath, hostSessions: created.hostSessions }, { repoPath: "/home/you/projects/agentmonitor", hostSessions: true });
  assert.equal(projects.find((candidate) => candidate.id === project.id)?.hostSessions, false);
  await page.goto(`${gateway.url}/#/t`);
  assert.equal(await menu.inputValue(), created?.id);

  // Cancelling the form keeps the project that was shown.
  await menu.selectOption({ label: "+ Project" });
  await form.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("navigation", { name: "Tasks" }).waitFor();
  assert.equal(await menu.inputValue(), created?.id);
});

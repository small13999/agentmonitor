import assert from "node:assert/strict";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Project, Session, Task, Topic } from "../shared/api.ts";
import { buildApp, Gateway, rgb } from "./harness.ts";
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

/** The notes textarea's value once it is `text`; the page polls the store, so this waits for it. */
async function notesShow(text: string): Promise<void> {
  await page.waitForFunction((expected) => document.querySelector("textarea")?.value === expected, text);
}

/** The All tasks list shows exactly these tasks, in this order; it polls the store, so this waits for it. */
async function allTasksShow(titles: string[]): Promise<void> {
  await page.waitForFunction(
    (expected) => JSON.stringify([...document.querySelectorAll(".all-tasks-row")].map((row) => row.getAttribute("data-task"))) === expected,
    JSON.stringify(titles),
  );
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

  // Choosing one opens it in the workspace, on its chat.
  await list.getByRole("link", { name: /26\.21 JP/ }).click();
  await page.waitForURL(new RegExp(`#/t/${jp.id}$`));
  assert.equal(await page.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"), "true");
  assert.equal(await list.getByRole("link", { name: /26\.21 JP/ }).getAttribute("aria-current"), "page");
});

spec("UI-2", "a task's workspace has Chat and Notes tabs, starts sessions, and has its settings behind the icon right of them", async () => {
  const target = await task("Workspace tabs");
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const tabs = page.getByRole("tablist", { name: "Workspace" });
  await tabs.getByRole("tab", { name: "Chat" }).waitFor();
  assert.deepEqual(await tabs.getByRole("tab").allTextContents(), ["Chat", "Notes"]);

  // Without a session, the chat tab starts one.
  await page.getByRole("region", { name: "Start session" }).getByRole("button", { name: "Start session" }).click();
  const chat = page.locator("iframe.session-frame.current");
  await chat.waitFor();
  await page.getByRole("region", { name: "Start session" }).waitFor({ state: "detached" });
  const { sessions } = await gateway.data<{ sessions: Session[] }>("GET", `/tasks/${target.id}`);
  assert.equal(sessions.length, 1);

  // Mark the chat's frame and count its loads: the Notes tab must neither replace nor reload it.
  await chat.evaluate((frame) => frame.setAttribute("data-mark", "kept"));
  const ternHost = `tern-${sessions[0].id}.localhost`;
  let loads = 0;
  page.on("framenavigated", (frame) => { if (frame.url().includes(ternHost)) loads++; });
  await tabs.getByRole("tab", { name: "Notes" }).click();
  await page.waitForURL(new RegExp(`#/t/${target.id}/notes$`));
  await page.getByRole("textbox", { name: "Notes" }).waitFor();
  await chat.waitFor({ state: "hidden" });
  await tabs.getByRole("tab", { name: "Chat" }).click();
  await chat.waitFor({ state: "visible" });
  await page.getByRole("textbox", { name: "Notes" }).waitFor({ state: "hidden" });
  assert.equal(await chat.getAttribute("data-mark"), "kept");
  assert.equal(loads, 0);

  // The settings: the task's state, its status, topic links (here a new topic, linked at once),
  // the session's changes and ending it, and finishing the task.
  await page.getByRole("button", { name: "Workspace settings" }).click();
  const settings = page.getByRole("complementary", { name: "Workspace settings" });
  const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/tasks/${target.id}`));
  await settings.getByRole("combobox", { name: "State" }).selectOption("in_review");
  assert.equal((await patched).status(), 200);
  assert.equal((await gateway.data<{ task: Task }>("GET", `/tasks/${target.id}`)).task.state, "in_review");
  await settings.getByRole("region", { name: "Status" }).getByText("No status yet.", { exact: false }).waitFor();
  await settings.getByRole("button", { name: "+ New topic" }).click();
  await settings.getByRole("textbox", { name: "New topic" }).fill("Release");
  await settings.getByRole("button", { name: "Add" }).click();
  await settings.getByRole("button", { name: "Unlink Release" }).waitFor();
  const linked = await gateway.data<{ topics: Topic[] }>("GET", `/tasks/${target.id}`);
  assert.deepEqual(linked.topics.map((topic) => topic.name), ["Release"]);
  await settings.getByRole("heading", { name: "Changes" }).waitFor();
  await settings.getByRole("button", { name: "End session" }).waitFor();
  await settings.getByRole("region", { name: "Finish task" }).getByRole("button", { name: "Mark done" }).waitFor();
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
});

spec("TASK-8", "a task's notes save as the user types, and its agents read and write them", async () => {
  const target = await task("Notes");
  const session = await start(target);
  await page.goto(`${gateway.url}/#/t/${target.id}/notes`);
  const notes = page.getByRole("textbox", { name: "Notes" });
  const saved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/tasks/${target.id}/notes`));
  await notes.fill("Ship 26.21 after QA");
  assert.equal((await saved).status(), 200);
  assert.equal(gateway.am(session.id, ["notes"]).stdout, "# revision 1\nShip 26.21 after QA\n");
  await page.reload();
  await notesShow("Ship 26.21 after QA");

  // The agent's write must name the revision it read.
  const stale = gateway.am(session.id, ["notes", "set", "--base", "0"], "Agent: QA passed\n");
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /current revision 1/);
  assert.equal(gateway.am(session.id, ["notes", "set", "--base", "1"], "Ship 26.21 after QA\nAgent: QA passed\n").code, 0);
  // The open page, with nothing unsaved, shows the agent's write.
  await notesShow("Ship 26.21 after QA\nAgent: QA passed\n");
});

spec("BOARD-3", "done and cancelled tasks leave the board; search and the All tasks list find every task by title and description", async () => {
  const recap = await gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title: "Season recap video", description: "Cut the worlds montage 5d2a" });
  const mobile = await task("Mobile leaderboard");
  const kr = await task("Patch notes KR");
  await gateway.data("POST", `/tasks/${recap.id}/finish`, { state: "done" });
  await gateway.data("POST", `/tasks/${mobile.id}/finish`, { state: "cancelled" });

  await page.goto(`${gateway.url}/#/`);
  const board = page.getByRole("region", { name: "Board" });
  await board.getByRole("article", { name: "Patch notes KR" }).waitFor();
  assert.equal(await board.getByRole("article", { name: "Season recap video" }).count(), 0);
  assert.equal(await board.getByRole("article", { name: "Mobile leaderboard" }).count(), 0);

  // The All tasks list has every task with its state, finished ones too.
  await page.getByRole("link", { name: "All tasks" }).click();
  await page.waitForURL(/#\/all$/);
  const list = page.getByRole("region", { name: "All tasks" });
  for (const [title, state] of [["Season recap video", "Done"], ["Mobile leaderboard", "Cancelled"], ["Patch notes KR", "Open"]]) {
    await list.locator(`[data-task="${title}"]`).getByText(state, { exact: true }).waitFor();
  }

  // Search finds tasks by a word of their description or their title, in any case and order.
  const search = page.getByRole("searchbox", { name: "Search tasks" });
  await search.fill("MONTAGE");
  await search.press("Enter");
  await page.waitForURL(/#\/all\?q=MONTAGE$/);
  await allTasksShow(["Season recap video"]);
  await search.fill("leaderboard mobile");
  await search.press("Enter");
  await allTasksShow(["Mobile leaderboard"]);
  await search.fill("nothing like this 0f0f");
  await search.press("Enter");
  await list.getByText("No task matches.").waitFor();

  // Agents search the same way (STORE-5).
  const session = await start(kr);
  const found = gateway.am(session.id, ["task", "search", "montage"]);
  assert.equal(found.stdout, `${recap.id} done        Season recap video\n`);

  // A found task opens on its page.
  await search.fill("leaderboard");
  await search.press("Enter");
  await allTasksShow(["Mobile leaderboard"]);
  await list.getByRole("link", { name: "Mobile leaderboard" }).click();
  await page.waitForURL(new RegExp(`#/t/${mobile.id}$`));
});

spec("UI-4", "a topic's name shows in its colour everywhere; clicking it opens its rendered status and linked tasks", async () => {
  const worlds = await gateway.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Worlds" });
  await gateway.data("PUT", `/topics/${worlds.id}/status`, { status: "**Ship** the recap\n\n- [x] montage\n- [ ] thumbnails\n", baseRevision: 0 });
  const recap = await task("Worlds recap");
  const bracket = await task("Worlds bracket");
  for (const linked of [recap, bracket]) await gateway.data("PUT", `/tasks/${linked.id}/topics/${worlds.id}`);
  await gateway.data("POST", `/tasks/${bracket.id}/finish`, { state: "done" });

  // The same name in the topic's colour on the All tasks list and on the board.
  await page.goto(`${gateway.url}/#/all`);
  const listed = page.getByRole("region", { name: "All tasks" }).locator(`[data-task="Worlds bracket"]`).getByRole("button", { name: "Worlds" });
  await listed.waitFor();
  assert.equal(await listed.evaluate((element) => getComputedStyle(element).color), rgb(worlds.color));
  await page.goto(`${gateway.url}/#/`);
  const onCard = page.getByRole("article", { name: "Worlds recap" }).getByRole("button", { name: "Worlds" });
  await onCard.waitFor();
  assert.equal(await onCard.evaluate((element) => getComputedStyle(element).color), rgb(worlds.color));

  // Clicking it opens its panel on the board, rather than the card's task.
  await onCard.click();
  const panel = page.getByRole("complementary", { name: "Topic Worlds" });
  await panel.locator("strong", { hasText: "Ship" }).waitFor();
  assert.equal(await panel.getByRole("checkbox").count(), 2);
  assert.match(page.url(), /#\/$/);
  const tasks = panel.getByRole("region", { name: "Linked tasks" });
  assert.deepEqual(await tasks.locator(".name").allTextContents(), ["Worlds recap", "Worlds bracket"]);
  await tasks.getByRole("link", { name: /Worlds bracket/ }).click();
  await page.waitForURL(new RegExp(`#/t/${bracket.id}$`));
  await panel.waitFor({ state: "detached" });
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

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { Comment, HistoryEntry, Person, Project, Session, Task, Topic } from "../shared/api.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

let gateway: Gateway;
let chrome: Browser;
let page: Page;
let project: Project;
let owner: Person;

before(async () => {
  await buildApp();
  [gateway, chrome] = await Promise.all([Gateway.start(), chromium.launch()]);
  page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
  owner = (await gateway.data<{ person: Person }>("GET", "/me")).person;
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
});

function task(title: string, description?: string): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title, ...(description === undefined ? {} : { description }) });
}

function start(target: Task): Promise<Session> {
  return gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {});
}

async function taskOf(id: string): Promise<Task> {
  return (await gateway.data<{ task: Task }>("GET", `/tasks/${id}`)).task;
}

/** Waits for the page's PATCH of the task, which an in-place edit sends. */
function patched(taskId: string): Promise<unknown> {
  return page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/tasks/${taskId}`));
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** The initials an avatar draws. */
async function drawnInitials(avatar: Locator): Promise<string> {
  return avatar.evaluate((element) => getComputedStyle(element, "::before").content.replace(/^"|"$/g, ""));
}

spec("TASK-12", "opening a task from the board, the task list, or a link shows its page, where its fields are edited in place", async () => {
  const target = await task("Patch notes 26.21", "Translate the **JP** notes.");
  const release = await gateway.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Release" });
  const ads = await gateway.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Ads" });
  await gateway.data("PUT", `/tasks/${target.id}/topics/${release.id}`);
  await gateway.data("POST", `/tasks/${target.id}/comments`, { body: "Wait for QA" });
  await start(target);
  const jogi = await gateway.data<Person>("POST", "/people", { name: "Jogi", email: "jogi@example.com" });

  const taskPage = page.getByRole("article", { name: "Task page" });
  const opened = async () => {
    await page.waitForURL(new RegExp(`#/t/${target.id}$`));
    assert.equal(await page.getByRole("tab", { name: "Page" }).getAttribute("aria-selected"), "true");
    assert.equal(await taskPage.getByRole("textbox", { name: "Title" }).inputValue(), "Patch notes 26.21");
  };
  await page.goto(`${gateway.url}/#/`);
  await page.getByRole("region", { name: "In progress" }).getByRole("link", { name: /Patch notes 26\.21/ }).click();
  await opened();
  await page.goto(`${gateway.url}/#/t`);
  await page.getByRole("navigation", { name: "Tasks" }).getByRole("link", { name: /Patch notes 26\.21/ }).click();
  await opened();
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  await opened();

  // Everything the page holds.
  await taskPage.getByRole("region", { name: "Description" }).locator("strong", { hasText: "JP" }).waitFor();
  assert.equal(await taskPage.getByRole("combobox", { name: "State" }).inputValue(), "in_progress");
  assert.equal(await taskPage.getByRole("combobox", { name: "Assignee" }).inputValue(), "");
  await taskPage.getByRole("region", { name: "Topics" }).getByText("Release").waitFor();
  await taskPage.getByRole("region", { name: "Folder" }).waitFor();
  await taskPage.getByRole("region", { name: "Comments" }).getByText("Wait for QA").waitFor();
  await taskPage.getByRole("region", { name: "History" }).getByText("created the task").waitFor();
  assert.equal(await taskPage.getByRole("region", { name: "Sessions" }).locator(".session-row").count(), 1);

  // Edited in place: title, description, state, assignee, topics.
  let saved = patched(target.id);
  await taskPage.getByRole("textbox", { name: "Title" }).fill("Patch notes 26.22");
  await taskPage.getByRole("textbox", { name: "Title" }).press("Enter");
  await saved;
  saved = patched(target.id);
  await taskPage.getByRole("button", { name: "Edit description" }).click();
  await taskPage.getByRole("region", { name: "Description" }).getByRole("textbox", { name: "Description" }).fill("Translate the *EN* notes.");
  await taskPage.getByRole("button", { name: "Save" }).click();
  await saved;
  await taskPage.getByRole("region", { name: "Description" }).locator("em", { hasText: "EN" }).waitFor();
  saved = patched(target.id);
  await taskPage.getByRole("combobox", { name: "State" }).selectOption("in_review");
  await saved;
  saved = patched(target.id);
  await taskPage.getByRole("combobox", { name: "Assignee" }).selectOption({ label: "Jogi" });
  await saved;
  const linked = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/topics/${ads.id}`));
  await taskPage.getByRole("combobox", { name: "Link topic" }).selectOption({ label: "Ads" });
  await linked;
  const unlinked = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/topics/${release.id}`));
  await taskPage.getByRole("button", { name: "Unlink Release" }).click();
  await unlinked;

  const edited = await gateway.data<{ task: Task; topics: Topic[] }>("GET", `/tasks/${target.id}`);
  assert.deepEqual(
    { title: edited.task.title, description: edited.task.description, state: edited.task.state, assigneeId: edited.task.assigneeId },
    { title: "Patch notes 26.22", description: "Translate the *EN* notes.", state: "in_review", assigneeId: jogi.id },
  );
  assert.deepEqual(edited.topics.map((topic) => topic.name), ["Ads"]);
});

spec("TASK-12", "a link to a task of another project opens it and switches the project; a task no project has does not exist", async () => {
  const other = await gateway.data<Project>("POST", "/projects", { name: "agentmonitor" });
  const target = await task("Glossary");
  const picker = page.getByRole("navigation", { name: "Tasks" }).getByRole("combobox", { name: "Project" });
  // Loaded afresh: the project list is read at load.
  await page.goto(`${gateway.url}/#/t`);
  await page.reload();
  await picker.selectOption({ label: other.name });
  await page.getByRole("heading", { name: other.name }).waitFor();

  await page.goto(`${gateway.url}/#/t/${target.id}/settings`);
  await page.getByRole("tab", { name: "Settings", selected: true }).waitFor();
  assert.equal(await picker.inputValue(), project.id);
  await page.getByRole("tab", { name: "Page" }).click();
  assert.equal(await page.getByRole("article", { name: "Task page" }).getByRole("textbox", { name: "Title" }).inputValue(), "Glossary");

  await page.goto(`${gateway.url}/#/t/${crypto.randomUUID()}`);
  await page.getByText("This task does not exist.").waitFor();
  assert.equal(await picker.inputValue(), project.id);
});

spec("TASK-13", "a task's assignee is one person or nobody", async () => {
  const target = await task("Leaderboard filters");
  const mia = await gateway.data<Person>("POST", "/people", { name: "Mia Wong", email: "mia@example.com" });
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const field = page.getByRole("region", { name: "Assignee" });
  const assignee = field.getByRole("combobox", { name: "Assignee" });
  await assignee.locator("option", { hasText: "Mia Wong" }).waitFor({ state: "attached" });
  const options = await assignee.locator("option").allTextContents();
  assert.equal(options[0], "Nobody");
  assert.ok(options.includes("Mia Wong") && options.includes(owner.name), `the picker offers the store's people: ${options.join(", ")}`);

  let saved = patched(target.id);
  await assignee.selectOption({ label: "Mia Wong" });
  await saved;
  assert.equal((await taskOf(target.id)).assigneeId, mia.id);
  assert.equal(await drawnInitials(field.locator(".avatar")), "MW");

  saved = patched(target.id);
  await assignee.selectOption({ label: "Nobody" });
  await saved;
  assert.equal((await taskOf(target.id)).assigneeId, null);
  await field.locator(".avatar").waitFor({ state: "detached" });

  // Only a person of the store, and only one.
  assert.equal((await gateway.api("PATCH", `/tasks/${target.id}`, { assigneeId: "00000000-0000-4000-8000-000000000000" })).status, 404);
  assert.equal((await gateway.api("PATCH", `/tasks/${target.id}`, { assigneeId: [mia.id, owner.id] })).status, 400);
});

spec("TASK-14", "a task's history lists its changes, topic links, sessions with their machine, and comments in time order, with who and when", async () => {
  const target = await task("History");
  const topic = await gateway.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Chronicle" });
  const kim = await gateway.data<Person>("POST", "/people", { name: "Kim", email: "kim@example.com" });
  const session = await start(target);
  await gateway.data("PATCH", `/tasks/${target.id}`, { assigneeId: kim.id });
  assert.equal(gateway.am(session.id, ["topic", "link", "Chronicle"]).code, 0);
  assert.equal(gateway.am(session.id, ["comment"], "Glossary done").code, 0);
  await gateway.data("POST", `/tasks/${target.id}/comments`, { body: "Thanks" });
  await gateway.data("POST", `/sessions/${session.id}/end`, {});
  await gateway.data("PATCH", `/tasks/${target.id}`, { state: "in_review" });

  const history = await gateway.data<HistoryEntry[]>("GET", `/tasks/${target.id}/history`);
  const human = { kind: "person", personId: owner.id };
  const agent = { kind: "agent", sessionId: session.id };
  assert.deepEqual(history.map(({ at: _at, ...entry }) => ("commentId" in entry ? { ...entry, commentId: "…" } : entry)), [
    { kind: "created", actor: human },
    { kind: "session", sessionId: session.id, event: "started", machine: session.machine, runtime: "container", actor: human },
    { kind: "state", from: "open", to: "in_progress", actor: human },
    { kind: "assignee", personId: kim.id, actor: human },
    { kind: "topic", topicId: topic.id, name: "Chronicle", linked: true, actor: agent },
    { kind: "comment", commentId: "…", actor: agent },
    { kind: "comment", commentId: "…", actor: human },
    { kind: "session", sessionId: session.id, event: "ended", machine: session.machine, runtime: "container", actor: human },
    { kind: "state", from: "in_progress", to: "in_review", actor: human },
  ]);
  assert.ok(history.every((entry, index) => index === 0 || entry.at >= history[index - 1].at), "in time order");
  assert.ok(session.machine !== null && session.machine.length > 0);

  // The page says each, with who did it and when.
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const shown = page.getByRole("region", { name: "History" }).locator("li");
  await shown.nth(history.length - 1).waitFor();
  const lines = await shown.evaluateAll((items) => items.map((item) => [item.querySelector(".actor-name")?.textContent ?? "", item.querySelector("time")?.getAttribute("datetime") ?? ""]));
  assert.deepEqual(lines.map(([who]) => who), [owner.name, owner.name, owner.name, owner.name, "Agent · History", "Agent · History", owner.name, owner.name, owner.name]);
  assert.deepEqual(lines.map(([, at]) => at), history.map((entry) => new Date(entry.at).toISOString()));
  for (const text of [`started a session on ${session.machine}`, "moved it from Open to In progress", "assigned it to Kim", "linked topic Chronicle", `ended a session on ${session.machine}`]) {
    await shown.filter({ hasText: text }).first().waitFor();
  }
  assert.equal(await shown.filter({ hasText: "wrote a comment" }).count(), 2);
});

/** The store's schema before comments: tasks have notes, as TASK-8 had them. */
const NOTES_SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, repo_path TEXT, host_sessions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, assignee_id TEXT REFERENCES people(id), branch TEXT, base_ref TEXT, status TEXT NOT NULL DEFAULT '',
  status_revision INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', notes_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, actor_kind TEXT, actor_id TEXT, data TEXT NOT NULL
);
`;

spec("TASK-15", "every task's notes became a comment by the store's owner, dated when they were last written", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "am-gw-"));
  const old = new DatabaseSync(join(stateDir, "store.sqlite"));
  old.exec(NOTES_SCHEMA);
  old.exec(`
    INSERT INTO projects (id, name, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'draftcoach', 1);
    INSERT INTO people VALUES ('00000000-0000-4000-8000-0000000000b1', 'armin', '#0090ff', 1, 1);
    INSERT INTO tasks (id, project_id, title, state, notes, notes_revision, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 'Patch notes', 'in_progress', 'Ship after **QA**', 4, 100, 1700000000000);
    INSERT INTO tasks (id, project_id, title, state, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000001', 'No notes', 'open', 200, 300);
    INSERT INTO task_events (task_id, at, actor_kind, actor_id, data) VALUES ('00000000-0000-4000-8000-000000000021', 100, 'person', '00000000-0000-4000-8000-0000000000b1', '{"kind":"created"}');
  `);
  old.close();

  const migrated = await Gateway.start({ runtime: "none", stateDir });
  try {
    const owner = { kind: "person", personId: "00000000-0000-4000-8000-0000000000b1" };
    const comments = await migrated.data<Comment[]>("GET", "/tasks/00000000-0000-4000-8000-000000000021/comments");
    assert.deepEqual(comments.map(({ id: _id, ...comment }) => comment), [
      { taskId: "00000000-0000-4000-8000-000000000021", author: owner, body: "Ship after **QA**", createdAt: 1700000000000, editedAt: null },
    ]);
    assert.deepEqual(await migrated.data("GET", "/tasks/00000000-0000-4000-8000-000000000022/comments"), []);
    const history = await migrated.data<HistoryEntry[]>("GET", "/tasks/00000000-0000-4000-8000-000000000021/history");
    assert.deepEqual(history.at(-1), { kind: "comment", commentId: comments[0].id, at: 1700000000000, actor: owner });
    // Notes are gone: no route reads them, and a restart migrates nothing twice.
    assert.equal((await migrated.api("GET", "/tasks/00000000-0000-4000-8000-000000000021/notes")).status, 404);
  } finally {
    await migrated.stop();
  }
});

spec("COMMENT-1", "people comment from the task's page and agents with am comment; a comment shows rendered, with its author and time", async () => {
  const target = await task("Comments");
  const session = await start(target);
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const comments = page.getByRole("region", { name: "Comments" });
  const posted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/tasks/${target.id}/comments`));
  await comments.getByRole("textbox", { name: "Comment", exact: true }).fill("Ship **after** QA");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  assert.equal((await posted).status(), 200);
  assert.equal(await comments.getByRole("textbox", { name: "Comment", exact: true }).inputValue(), "", "the box empties once posted");

  const written = gateway.am(session.id, ["comment"], "QA passed on `26.21`\n");
  assert.equal(written.code, 0, written.stderr);

  const shown = comments.locator(".comment");
  await shown.nth(1).waitFor();
  const [mine, agents] = [shown.nth(0), shown.nth(1)];
  await mine.locator("strong", { hasText: "after" }).waitFor();
  assert.equal(await mine.locator(".actor-name").textContent(), owner.name);
  await agents.locator("code", { hasText: "26.21" }).waitFor();
  assert.equal(await agents.locator(".actor-name").textContent(), "Agent · Comments");
  const stored = await gateway.data<Comment[]>("GET", `/tasks/${target.id}/comments`);
  assert.deepEqual(stored.map((comment) => [comment.author, comment.body]), [
    [{ kind: "person", personId: owner.id }, "Ship **after** QA"],
    [{ kind: "agent", sessionId: session.id }, "QA passed on `26.21`"],
  ]);
  for (const [index, comment] of stored.entries()) {
    assert.equal(await shown.nth(index).locator("time").getAttribute("datetime"), new Date(comment.createdAt).toISOString());
  }
  // The agent reads them back.
  assert.match(gateway.am(session.id, ["comments"]).stdout, new RegExp(`^comment ${stored[0].id} by ${owner.name}, .*\\nShip \\*\\*after\\*\\* QA$`, "m"));
});

spec("COMMENT-2", "only a comment's author edits or deletes it, and an edited comment says so", async () => {
  const target = await task("Edits");
  const session = await start(target);
  const theirs = await gateway.data<Comment>("POST", `/tasks/${target.id}/comments`, { body: "Use the old glossary" });
  const agentWrote = gateway.am(session.id, ["--json", "comment"], "Started on JP");
  assert.equal(agentWrote.code, 0, agentWrote.stderr);
  const agents: unknown = JSON.parse(agentWrote.stdout);
  assert.ok(typeof agents === "object" && agents !== null && "id" in agents && typeof agents.id === "string");

  // Nobody changes another's comment.
  assert.equal((await gateway.api("PATCH", `/comments/${agents.id}`, { body: "Started on EN" })).status, 403);
  assert.equal((await gateway.api("DELETE", `/comments/${agents.id}`)).status, 403);
  const refused = gateway.am(session.id, ["comment", "edit", theirs.id], "Use the new glossary");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /only a comment's author can edit or delete it/);
  assert.equal(gateway.am(session.id, ["comment", "delete", theirs.id]).code, 1);

  // Each author changes their own: the agent with am, the person on the page.
  assert.equal(gateway.am(session.id, ["comment", "edit", agents.id], "Started on JP and EN").code, 0);
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const shown = page.getByRole("region", { name: "Comments" }).locator(".comment");
  await shown.nth(1).getByText("Started on JP and EN").waitFor();
  await shown.nth(1).getByText("(edited)").waitFor();
  assert.equal(await shown.nth(1).getByRole("button", { name: "Edit" }).count(), 0, "the page offers no edit of the agent's comment");
  assert.equal(await shown.nth(0).getByText("(edited)").count(), 0);
  await shown.nth(0).getByRole("button", { name: "Edit" }).click();
  await shown.nth(0).getByRole("textbox", { name: "Edit comment" }).fill("Use the new glossary");
  await shown.nth(0).getByRole("button", { name: "Save" }).click();
  await shown.nth(0).getByText("Use the new glossary").waitFor();
  await shown.nth(0).getByText("(edited)").waitFor();
  const edited = await gateway.data<Comment[]>("GET", `/tasks/${target.id}/comments`);
  assert.ok(edited.every((comment) => comment.editedAt !== null && comment.editedAt >= comment.createdAt));

  await shown.nth(0).getByRole("button", { name: "Delete" }).click();
  await shown.nth(0).getByRole("button", { name: "Delete comment" }).click();
  await page.getByRole("region", { name: "Comments" }).getByText("Use the new glossary").waitFor({ state: "detached" });
  assert.equal(gateway.am(session.id, ["comment", "delete", agents.id]).code, 0);
  assert.deepEqual(await gateway.data("GET", `/tasks/${target.id}/comments`), []);
  // The history keeps that they were written.
  await page.getByRole("region", { name: "History" }).getByText("wrote a comment, since deleted").nth(1).waitFor();
});

spec("PERSON-1", "the owner adds and renames people in the app; each shows as initials on their colour, and human actions are recorded with the person", async () => {
  const target = await task("People");
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  await page.getByRole("region", { name: "Assignee" }).getByRole("button", { name: "People…" }).click();
  const dialog = page.getByRole("dialog", { name: "People" });
  await dialog.getByRole("button", { name: "+ Add person" }).click();
  await dialog.getByRole("textbox", { name: "Name of the new person" }).fill("Jonas Berg");
  await dialog.getByRole("textbox", { name: "Email of the new person" }).fill("Jonas@Example.com");
  await dialog.getByRole("button", { name: "Add" }).click();
  const name = dialog.getByRole("textbox", { name: "Name of Jonas Berg" });
  await name.waitFor();
  const added = (await gateway.data<Person[]>("GET", "/people")).find((person) => person.name === "Jonas Berg");
  assert.ok(added, "the person is in the store");
  assert.equal(added.email, "jonas@example.com");
  const avatar = dialog.locator(".person", { has: page.getByRole("textbox", { name: "Name of Jonas Berg" }) }).locator(".avatar");
  assert.equal(await drawnInitials(avatar), "JB");
  assert.equal(await avatar.evaluate((element) => getComputedStyle(element).backgroundColor), rgb(added.color));

  await name.fill("Jonas Lind");
  await name.press("Enter");
  await dialog.getByRole("textbox", { name: "Name of Jonas Lind" }).waitFor();
  assert.equal((await gateway.data<Person[]>("GET", "/people")).find((person) => person.id === added.id)?.name, "Jonas Lind");
  assert.equal(await drawnInitials(dialog.locator(".person", { has: page.getByRole("textbox", { name: "Name of Jonas Lind" }) }).locator(".avatar")), "JL");
  await dialog.getByRole("button", { name: "Close people" }).click();
  await dialog.waitFor({ state: "detached" });

  // What a person does on the page is recorded, and shown, with them.
  const saved = patched(target.id);
  await page.getByRole("combobox", { name: "State" }).selectOption("in_review");
  await saved;
  const history = await gateway.data<HistoryEntry[]>("GET", `/tasks/${target.id}/history`);
  assert.deepEqual(history.at(-1)?.actor, { kind: "person", personId: owner.id });
  const entry = page.getByRole("region", { name: "History" }).locator("li", { hasText: "moved it from Open to In review" });
  await entry.waitFor();
  assert.equal(await entry.locator(".actor-name").textContent(), owner.name);
  assert.equal(await entry.locator(".avatar").evaluate((element) => getComputedStyle(element).backgroundColor), rgb(owner.color));
});

spec("PERSON-2", "an agent's actions are recorded as its session's agent, shown with the session's avatar and linking to the session", async () => {
  const target = await task("Agent actions");
  const session = await start(target);
  assert.equal(gateway.am(session.id, ["task", "set-state", "in_review"]).code, 0);
  const history = await gateway.data<HistoryEntry[]>("GET", `/tasks/${target.id}/history`);
  assert.deepEqual(history.at(-1)?.actor, { kind: "agent", sessionId: session.id });

  await page.goto(`${gateway.url}/#/t/${target.id}`);
  const entry = page.getByRole("region", { name: "History" }).locator("li", { hasText: "moved it from In progress to In review" });
  const agent = entry.getByRole("link", { name: "Agent · Agent actions" });
  await agent.waitFor();
  assert.equal(await agent.getAttribute("data-session"), session.id);
  await agent.locator(".avatar-agent").waitFor();
  // The session's avatar is the same wherever its agent shows, here beside the session itself.
  const sessionAvatar = page.getByRole("region", { name: "Sessions" }).locator(`[data-session="${session.id}"] .avatar-agent`);
  const color = (element: Element) => getComputedStyle(element).backgroundColor;
  assert.equal(await agent.locator(".avatar-agent").evaluate(color), await sessionAvatar.evaluate(color));
  // A running session's agent links to its chat; an ended one's to the task's page, which lists the session.
  assert.equal(await agent.getAttribute("href"), `#/t/${target.id}/chat`);
  await gateway.data("POST", `/sessions/${session.id}/end`, {});
  await page.waitForFunction((id) => document.querySelector(`.history [data-session="${id}"]`)?.getAttribute("href")?.endsWith("/chat") === false, session.id);
  assert.equal(await agent.getAttribute("href"), `#/t/${target.id}`);
});

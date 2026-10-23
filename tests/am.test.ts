import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Card, Comment, Person, Project, Session, Task, Topic } from "../shared/api.ts";
import { buildApp, Gateway, type AmResult } from "./harness.ts";
import { spec } from "./spec.ts";

// STORE-5: each test reads what the UI shows and what `am` answers through a session's
// socket, as its agent runs it, and compares them.
let scratch: string;
let gateway: Gateway;
let chrome: Browser;
let page: Page;
let project: Project;

before(async () => {
  buildApp();
  scratch = mkdtempSync(join(tmpdir(), "am-cli-"));
  const config = join(scratch, "config");
  mkdirSync(join(config, "cloudflare"), { recursive: true });
  writeFileSync(join(config, "cloudflare", "cloudflare-fixture.env"), "CLOUDFLARE_READ_TOKEN=cf-read\nCLOUDFLARE_WRITE_TOKEN=cf-write\n");
  [gateway, chrome] = await Promise.all([Gateway.start({ runtime: "none", env: { AGENTMONITOR_CONFIG_DIR: config } }), chromium.launch()]);
  page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function task(title: string, inProject = project): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${inProject.id}/tasks`, { title });
}

function start(target: Task): Promise<Session> {
  return gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {});
}

/** The lines `am` printed; fails the test unless it succeeded. */
function lines(result: AmResult): string[] {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.replace(/\n$/, "").split("\n");
}

/** Opens the app on a page of the given project, the one the project menu chose last. */
async function open(inProject: Project, hash: string): Promise<void> {
  await page.goto(`${gateway.url}/#/`);
  await page.evaluate((id) => localStorage.setItem("am.project", id), inProject.id);
  await page.goto(`${gateway.url}/${hash}`);
  await page.reload();
}

spec("STORE-5", "am task history says what the task page's History says, entry by entry", async () => {
  const target = await task("History for agents");
  await gateway.data<Topic>("POST", `/projects/${project.id}/topics`, { name: "Chronicle" });
  const kim = await gateway.data<Person>("POST", "/people", { name: "Kim" });
  const session = await start(target);
  await gateway.data("PATCH", `/tasks/${target.id}`, { assigneeId: kim.id });
  lines(gateway.am(session.id, ["topic", "link", "Chronicle"]));
  lines(gateway.am(session.id, ["comment"], "Glossary done"));
  const typo = await gateway.data<Comment>("POST", `/tasks/${target.id}/comments`, { body: "Tpyo" });
  await gateway.data("DELETE", `/comments/${typo.id}`);
  lines(gateway.am(session.id, ["task", "set-state", "in_review"]));

  const said = lines(gateway.am(session.id, ["task", "history"])).map((line) => line.split("\t"));
  await open(project, `#/t/${target.id}`);
  const entries = page.getByRole("region", { name: "History" }).locator("li");
  await entries.nth(said.length - 1).waitFor();
  const shown = await entries.evaluateAll((items) => items.map((item) => [item.querySelector(".actor-name")?.textContent ?? "", item.children[1]?.textContent ?? ""]));
  const agent = `Agent · ${session.name}`;
  assert.deepEqual(said.map(([, who, what]) => [who, what]), shown.map(([who, what]) => [who === agent ? "this session's agent" : who, what]));
  assert.deepEqual(said.map(([, , what]) => what), [
    "created the task",
    "started a session on Agent Monitor",
    "moved it from Open to In progress",
    "assigned it to Kim",
    "linked topic Chronicle",
    "wrote a comment",
    "wrote a comment, since deleted",
    "moved it from In progress to In review",
  ]);
  assert.ok(said.every(([at], index) => index === 0 || Date.parse(at) >= Date.parse(said[index - 1][0])), "oldest first");
});

spec("STORE-5", "am people lists the people the People dialog lists, the owner first", async () => {
  await gateway.data<Person>("POST", "/people", { name: "Jogi" });
  const target = await task("People for agents");
  const session = await start(target);
  const said = lines(gateway.am(session.id, ["people"]));

  await open(project, `#/t/${target.id}`);
  await page.getByRole("region", { name: "Assignee" }).getByRole("button", { name: "People…" }).click();
  const dialog = page.getByRole("dialog", { name: "People" });
  await dialog.getByRole("textbox", { name: "Name of Jogi" }).waitFor();
  const shown = await dialog.locator("li.person").evaluateAll((items) => items.map((item) => ({
    name: item.querySelector("input")?.value ?? "",
    owner: item.querySelector(".muted.small")?.textContent === "owner",
  })));
  const people = await gateway.data<Person[]>("GET", "/people");
  assert.deepEqual(said, people.map((person) => `${person.id} ${person.name}${person.owner ? " (owner)" : ""}`));
  assert.deepEqual(people.map((person) => ({ name: person.name, owner: person.owner })), shown);
  assert.equal(shown[0].owner, true);
});

spec("STORE-5", "am project show says what the project settings page says, and follows its changes", async () => {
  const own = await gateway.data<Project>("POST", "/projects", { name: "settings-fixture", repoPath: "/srv/settings-fixture" });
  const session = await start(await task("Settings for agents", own));
  const said = () => lines(gateway.am(session.id, ["project", "show"]));

  // The project menu chooses the project; its board links to the settings.
  await page.goto(`${gateway.url}/#/t`);
  await page.reload();
  await page.getByRole("navigation", { name: "Tasks" }).getByRole("combobox", { name: "Project" }).selectOption({ label: "settings-fixture" });
  await page.getByRole("heading", { name: "settings-fixture" }).waitFor();
  await page.getByRole("link", { name: "Project settings" }).click();
  const form = page.getByRole("form", { name: "Project settings" });
  const name = form.getByRole("textbox", { name: "Name" });
  const repository = form.getByRole("textbox", { name: "Repository" });
  const hostSessions = form.getByRole("checkbox", { name: /Allow host sessions/ });
  assert.deepEqual([await name.inputValue(), await repository.inputValue(), await hostSessions.isChecked()], ["settings-fixture", "/srv/settings-fixture", false]);
  assert.deepEqual(said(), [`project settings-fixture (${own.id})`, "repository /srv/settings-fixture", "host sessions not allowed"]);

  // A running session works in a worktree of the repository, which stays while it runs.
  await repository.fill("/srv/elsewhere");
  await form.getByRole("button", { name: "Save" }).click();
  await form.getByText("end the project's 1 running session(s) before changing its repository").waitFor();
  assert.equal(said()[1], "repository /srv/settings-fixture");

  await repository.fill("/srv/settings-fixture");
  await name.fill("settings-renamed");
  await hostSessions.check();
  await form.getByRole("button", { name: "Save" }).click();
  await form.getByRole("status").getByText("Saved.").waitFor();
  assert.deepEqual(said(), [`project settings-renamed (${own.id})`, "repository /srv/settings-fixture", "host sessions allowed"]);
  await page.getByRole("link", { name: "Back to the board" }).click();
  await page.getByRole("heading", { name: "settings-renamed" }).waitFor();
});

spec("STORE-5", "am board shows the board's columns with each card's title, topics, assignee, and session", async () => {
  const board = await gateway.data<Project>("POST", "/projects", { name: "board-fixture" });
  const copy = await gateway.data<Topic>("POST", `/projects/${board.id}/topics`, { name: "Copy" });
  const lea = await gateway.data<Person>("POST", "/people", { name: "Lea" });
  const draft = await task("Draft the notes", board);
  await gateway.data("PUT", `/tasks/${draft.id}/topics/${copy.id}`);
  const write = await task("Write the notes", board);
  const session = await start(write);
  const check = await task("Check the notes", board);
  await gateway.data("PATCH", `/tasks/${check.id}`, { state: "in_review", assigneeId: lea.id });
  const old = await task("Old notes", board);
  await gateway.data("POST", `/tasks/${old.id}/finish`, { state: "done" });

  // Column headings, then one row per card: id, title, topics, assignee, session.
  const said = new Map<string, string[][]>();
  let column: string[][] = [];
  for (const line of lines(gateway.am(session.id, ["board"]))) {
    if (line.startsWith("  ")) column.push(line.trim().split("\t").slice(1));
    else said.set(line, column = []);
  }

  await open(board, "#/");
  const columns = page.getByRole("region", { name: "Board" });
  await columns.locator(".card-session .machine").waitFor();
  const shown = new Map<string, string[][]>();
  for (const label of ["Open", "In progress", "In review"]) {
    const region = columns.getByRole("region", { name: label, exact: true });
    const count = await region.locator(".count").textContent();
    shown.set(`${label} (${count})`, await region.locator("article.card").evaluateAll((cards) => cards.map((card) => [
      card.querySelector(".card-link")?.textContent ?? "",
      [...card.querySelectorAll(".topic-name")].map((topic) => topic.textContent).join(", ") || "no topics",
      card.querySelector("[role=img]")?.getAttribute("aria-label") ?? "nobody",
      card.querySelector(".turn") === null
        ? card.querySelector(".card-session")?.textContent?.toLowerCase() ?? ""
        : `${card.querySelector(".turn")?.textContent} on ${card.querySelector(".machine")?.textContent}`,
    ])));
  }
  assert.deepEqual(said, shown);
  assert.deepEqual([...said.entries()], [
    ["Open (1)", [["Draft the notes", "Copy", "nobody", "no session"]]],
    ["In progress (1)", [["Write the notes", "no topics", "nobody", "Stopped on Agent Monitor"]]],
    ["In review (1)", [["Check the notes", "no topics", "Lea", "no session"]]],
  ]);
});

spec("STORE-5", "am changes and shows another task's title, description, state, assignee, and topics as its page shows them", async () => {
  const own = await task("The agent's own");
  const other = await task("Before");
  await gateway.data<Person>("POST", "/people", { name: "Ines" });
  const session = await start(own);
  const onOther = ["--task", other.id];
  lines(gateway.am(session.id, ["task", "set-title", "After", ...onOther]));
  lines(gateway.am(session.id, ["task", "set-description", ...onOther], "Ship the **JP** notes first.\n"));
  lines(gateway.am(session.id, ["task", "assign", "Ines", ...onOther]));
  lines(gateway.am(session.id, ["task", "set-state", "in_review", ...onOther]));
  lines(gateway.am(session.id, ["topic", "create", "Release"]));
  lines(gateway.am(session.id, ["topic", "link", "Release", ...onOther]));

  assert.deepEqual(lines(gateway.am(session.id, ["task", "show", ...onOther])), [
    `task After (${other.id})`,
    "state  in_review",
    "assignee Ines",
    "branch none",
    "topics Release",
    "",
    "description:",
    "Ship the **JP** notes first.",
    "",
    "status (revision 0):",
    "(none yet)",
    "",
    "sessions:",
    "(none)",
  ]);
  await open(project, `#/t/${other.id}`);
  const taskPage = page.getByRole("article", { name: "Task page" });
  assert.equal(await taskPage.getByRole("textbox", { name: "Title" }).inputValue(), "After");
  await taskPage.getByRole("region", { name: "Description" }).locator("strong", { hasText: "JP" }).waitFor();
  assert.equal(await taskPage.getByRole("combobox", { name: "State" }).inputValue(), "in_review");
  assert.equal(await taskPage.getByRole("combobox", { name: "Assignee" }).locator("option:checked").textContent(), "Ines");
  assert.deepEqual(await taskPage.getByRole("region", { name: "Topics" }).locator(".topic-name").allTextContents(), ["Release"]);
  await taskPage.getByRole("region", { name: "Sessions" }).getByText("No session has worked on this task yet.").waitFor();

  // The agent's own task is as it was, with its running session.
  const mine = lines(gateway.am(session.id, ["task", "show"]));
  assert.equal(mine[0], `task The agent's own (${own.id})`);
  assert.match(mine.at(-1) ?? "", new RegExp(`^${session.id}\trunning\tstarted \\S+ on Agent Monitor\tcontainer$`));
});

spec("STORE-5", "am session show says the session's state and its Cloudflare access as the task's Settings tab does", async () => {
  const cloudflare = await gateway.data<Project>("POST", "/projects", { name: "cloudflare-fixture" });
  const target = await task("Cloudflare for agents", cloudflare);
  const session = await start(target);
  const said = () => lines(gateway.am(session.id, ["session", "show"]));
  assert.deepEqual(said().slice(3), ["machine Agent Monitor (container)", "running: Stopped", "cloudflare reads; writes are off"]);

  await open(cloudflare, `#/t/${target.id}/settings`);
  const settings = page.getByRole("region", { name: "Settings" });
  await settings.locator(".turn", { hasText: "Stopped" }).waitFor();
  await settings.getByRole("tab", { name: "Cloudflare" }).click();
  const access = settings.getByRole("region", { name: "Cloudflare" });
  await access.getByText("The agent can read. Writes are off.").waitFor();
  await access.getByRole("button", { name: "Allow writes for 10 min" }).click();
  await access.getByText(/^Writes allowed until/).waitFor();

  const card = (await gateway.data<Card[]>("GET", `/projects/${cloudflare.id}/cards`)).find((candidate) => candidate.session.id === session.id);
  assert.ok(card?.cloudflare?.writesUntil != null);
  assert.equal(said().at(-1), `cloudflare reads; writes allowed until ${new Date(card.cloudflare.writesUntil).toISOString()}`);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { Automation, AutomationSummary, Person, Project, Session, Trigger } from "../shared/api.ts";
import { buildApp, Gateway, png } from "./harness.ts";
import { spec } from "./spec.ts";

let gateway: Gateway;
let chrome: Browser;
let page: Page;
let project: Project;
let owner: Person;
let scratch: string;

before(async () => {
  await buildApp();
  [gateway, chrome] = await Promise.all([Gateway.start(), chromium.launch()]);
  page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
  owner = (await gateway.data<{ person: Person }>("GET", "/me")).person;
  await gateway.data("PATCH", `/people/${owner.id}`, { name: "Kim Park" });
  scratch = mkdtempSync(join(tmpdir(), "am-automation-page-"));
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** The run's agent writes an output into `runs/<run>/` of the automation's folder, as runs do. */
function output(run: Session, name: string, bytes: Buffer | string): void {
  const file = join(scratch, `${run.id}-${name}`);
  writeFileSync(file, bytes);
  const added = gateway.am(run.id, ["folder", "add", file, `runs/${run.id.slice(0, 8)}/${name}`]);
  assert.equal(added.code, 0, added.stderr);
}

/** Whether `first` comes before `second` in the page. */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const handle = await second.elementHandle();
  return first.evaluate((node, other) => other !== null && (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, handle);
}

spec("AUTO-7", "an automation's page shows first what its runs produced and what waits for review, then its runs and firings; a run's outputs download with one click", async () => {
  const automation = await gateway.data<Automation>("POST", `/projects/${project.id}/automations`, {
    name: "Patch review",
    instructions: "Review the new patch notes.",
    endMode: "review",
  });
  const trigger = await gateway.data<Trigger>("POST", `/automations/${automation.id}/triggers`, { cron: "0 9 * * 1-5", guardPath: "guard.sh", checkPath: "check.md" });

  // A run started by hand wrote a report and a chart, and ended.
  const first = await gateway.data<Session>("POST", `/automations/${automation.id}/runs`, {});
  const report = "# 26.21\n\nNothing breaks.\n";
  const chart = png();
  output(first, "report.md", report);
  output(first, "chart.png", chart);
  await gateway.data("POST", `/sessions/${first.id}/end`);
  // A later run wrote its summary and waits for review with its session open.
  const second = await gateway.data<Session>("POST", `/automations/${automation.id}/runs`, {});
  output(second, "summary.md", "# 26.22\n\nTwo balance changes.\n");

  // The scheduler records each firing with what the guard and check said (AUTO-8), and the run's
  // agent says it waits for review (AUTO-10); this test writes those records into the store.
  const store = new DatabaseSync(join(gateway.stateDir, "store.sqlite"));
  store.exec("PRAGMA busy_timeout = 5000");
  store.prepare("UPDATE sessions SET run_outcome = 'review', run_started_by_kind = NULL, run_started_by_id = NULL WHERE id = ?").run(second.id);
  const firing = store.prepare(
    "INSERT INTO automation_firings (id, automation_id, trigger_id, scheduled_at, fired_at, guard_verdict, check_verdict, outcome, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const verdict = (passed: boolean, said: string) => JSON.stringify({ passed, output: said });
  firing.run(randomUUID(), automation.id, trigger.id, second.startedAt - 1_000, second.startedAt, verdict(true, "26.22 is out"), verdict(true, "Yes: new balance notes"), "started", second.id);
  firing.run(randomUUID(), automation.id, trigger.id, first.startedAt - 1_000, first.startedAt - 900, verdict(true, "26.21b is out"), verdict(false, "No: only a typo fix"), "check", null);
  store.close();

  await page.goto(`${gateway.url}/#/a/${automation.id}`);
  const automationPage = page.getByRole("article", { name: "Automation page" });
  const review = automationPage.getByRole("region", { name: "Waiting for review" });
  const outputs = automationPage.getByRole("region", { name: "Outputs" });
  const runs = automationPage.getByRole("region", { name: "Runs and firings" });
  const [short1, short2] = [first.id.slice(0, 8), second.id.slice(0, 8)];

  // First what the runs produced, the newest run first, images inline; and the run waiting for review.
  await outputs.getByRole("article", { name: `Outputs of run ${short1}` }).waitFor();
  assert.deepEqual(await outputs.getByRole("article").evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label"))), [
    `Outputs of run ${short2}`,
    `Outputs of run ${short1}`,
  ]);
  const image = outputs.getByRole("img", { name: `runs/${short1}/chart.png` });
  await image.waitFor();
  await page.waitForFunction((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth === 2, await image.elementHandle());
  await outputs.getByRole("button", { name: /report\.md/ }).click();
  await outputs.getByRole("heading", { name: "26.21" }).waitFor();
  await review.getByText(`Run ${short2}`).waitFor();
  assert.equal(await review.getByText(`Run ${short1}`).count(), 0, "an ended run waits for nobody");
  assert.ok(await precedes(review, runs), "what waits for review comes before the runs");
  assert.ok(await precedes(outputs, runs), "the outputs come before the runs");

  // Then the runs and firings, newest first: when, what started it, what the guard and check said, how it went, and its session.
  const rows = runs.locator("tbody tr");
  await rows.nth(2).waitFor();
  const texts = await rows.allTextContents();
  assert.equal(texts.length, 3);
  assert.match(texts[0], /Schedule 0 9 \* \* 1-5.*Passed26\.22 is out.*PassedYes: new balance notes.*Waiting for review.*Run [0-9a-f]{8}/);
  assert.ok(texts[0].includes(`Run ${short2}`));
  assert.match(texts[1], /Run now by Kim Park.*Ended.*ended/);
  assert.ok(texts[1].includes(`Run ${short1}`));
  assert.match(texts[2], /Schedule 0 9 \* \* 1-5.*Passed26\.21b is out.*FailedNo: only a typo fix.*Stopped by the check/);

  // A run's outputs download with one click, as a zip of its folder.
  const downloading = page.waitForEvent("download");
  await outputs.getByRole("link", { name: `Download outputs of run ${short1}` }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), `Patch-review-${short1}.zip`);
  const zipPath = join(scratch, "outputs.zip");
  await download.saveAs(zipPath);
  execFileSync("unzip", ["-tq", zipPath]);
  assert.deepEqual(execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean).sort(), ["chart.png", "report.md"]);
  assert.equal(execFileSync("unzip", ["-p", zipPath, "report.md"], { encoding: "utf8" }), report);
  assert.ok(execFileSync("unzip", ["-p", zipPath, "chart.png"]).equals(chart));

  // The run waiting for review opens its session's chat, as a task's does.
  await review.getByRole("link", { name: `Open session of run ${short2}` }).click();
  await page.getByRole("tab", { name: "Chat", selected: true }).waitFor();
  assert.match(page.url(), new RegExp(`#/a/${automation.id}/chat/${second.id}$`));
  await page.getByRole("region", { name: "Chat" }).waitFor();
});

spec("AUTO-15", "a person creates an automation with a trigger on the site, then changes it and its triggers", async () => {
  // The project menu and the board lead to the project's automations.
  await page.goto(`${gateway.url}/#/t`);
  await page.getByRole("navigation", { name: "Tasks" }).getByRole("combobox", { name: "Project" }).selectOption({ label: "Automations" });
  await page.waitForURL(/#\/a$/);
  await page.goto(`${gateway.url}/#/`);
  await page.getByRole("navigation", { name: "Board views" }).getByRole("link", { name: "Automations" }).click();
  await page.waitForURL(/#\/a$/);

  const list = page.getByRole("navigation", { name: "Automations" });
  await list.getByRole("link", { name: "+ Automation" }).click();
  const created = page.getByRole("form", { name: "New automation" });
  await created.getByRole("textbox", { name: "Name" }).fill("Release notes");
  await created.getByRole("textbox", { name: "Instructions" }).fill("Write the release notes of the week.");
  await created.getByRole("textbox", { name: "Model" }).fill("fake/scripted");
  await created.getByRole("combobox", { name: "End mode" }).selectOption("review");
  await created.getByRole("spinbutton", { name: "Time limit (minutes)" }).fill("45");
  await created.getByRole("button", { name: "+ Trigger" }).click();
  const firstTrigger = created.getByRole("group", { name: "Trigger 1" });
  await firstTrigger.getByRole("textbox", { name: "Schedule (cron)" }).fill("0 9 * * 1-5");
  assert.equal(await firstTrigger.getByRole("combobox", { name: "Timezone" }).inputValue(), "Europe/Budapest");
  await firstTrigger.getByRole("textbox", { name: "Guard (file)" }).fill("guard.sh");
  await created.getByRole("button", { name: "Create automation" }).click();
  await page.waitForURL(/#\/a\/[0-9a-f-]{36}$/);
  const automationId = /#\/a\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? "";
  await page.getByRole("article", { name: "Automation page" }).getByRole("heading", { name: "Release notes" }).waitFor();
  await list.getByRole("link", { name: "Release notes" }).waitFor();

  const stored = async () => (await gateway.data<AutomationSummary[]>("GET", `/projects/${project.id}/automations`)).find((found) => found.automation.id === automationId);
  let summary = await stored();
  assert.deepEqual(
    [summary?.automation.name, summary?.automation.instructions, summary?.automation.model, summary?.automation.endMode, summary?.automation.timeLimitMinutes, summary?.automation.enabled],
    ["Release notes", "Write the release notes of the week.", "fake/scripted", "review", 45, true],
  );
  assert.deepEqual(summary?.triggers.map((found) => [found.cron, found.timezone, found.guardPath, found.checkPath]), [["0 9 * * 1-5", "Europe/Budapest", "guard.sh", null]]);
  const triggerId = summary?.triggers[0].id;

  // Changed in its settings: the automation's fields, its trigger, and a second trigger.
  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByRole("form", { name: "Automation settings" });
  await settings.getByRole("combobox", { name: "End mode" }).selectOption("finish");
  await settings.getByRole("spinbutton", { name: "Time limit (minutes)" }).fill("30");
  await settings.getByRole("checkbox", { name: /^On/ }).uncheck();
  const edited = settings.getByRole("group", { name: "Trigger 1" });
  await edited.getByRole("textbox", { name: "Schedule (cron)" }).fill("30 7 * * *");
  await edited.getByRole("combobox", { name: "Timezone" }).fill("Asia/Tokyo");
  await edited.getByRole("textbox", { name: "Guard (file)" }).fill("");
  await edited.getByRole("textbox", { name: "Check (file)" }).fill("check.md");
  await settings.getByRole("button", { name: "+ Trigger" }).click();
  await settings.getByRole("group", { name: "Trigger 2" }).getByRole("textbox", { name: "Schedule (cron)" }).fill("0 18 * * 5");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await settings.getByRole("status").getByText("Saved").waitFor();
  summary = await stored();
  assert.deepEqual(
    [summary?.automation.endMode, summary?.automation.timeLimitMinutes, summary?.automation.enabled, summary?.automation.model],
    ["finish", 30, false, "fake/scripted"],
  );
  assert.deepEqual(summary?.triggers.map((found) => [found.id === triggerId, found.cron, found.timezone, found.guardPath, found.checkPath]), [
    [true, "30 7 * * *", "Asia/Tokyo", null, "check.md"],
    [false, "0 18 * * 5", "Europe/Budapest", null, null],
  ]);
  await list.getByRole("link", { name: /Release notes/ }).getByText("Off").waitFor();

  // A schedule the gateway refuses says why, and nothing of it is saved; removing a trigger removes it.
  await settings.getByRole("group", { name: "Trigger 1" }).getByRole("textbox", { name: "Schedule (cron)" }).fill("every morning");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await settings.getByText(/a cron schedule has five fields/).waitFor();
  await settings.getByRole("group", { name: "Trigger 1" }).getByRole("textbox", { name: "Schedule (cron)" }).fill("30 7 * * *");
  await settings.getByRole("button", { name: "Remove trigger 2" }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await settings.getByRole("status").getByText("Saved").waitFor();
  assert.deepEqual((await stored())?.triggers.map((found) => [found.id === triggerId, found.cron]), [[true, "30 7 * * *"]]);

  // Its folder is written on the site too: the memory its runs keep.
  await page.getByRole("tab", { name: "Page" }).click();
  const folder = page.getByRole("region", { name: "Folder" });
  await folder.getByRole("button", { name: "New file" }).click();
  const newFile = folder.getByRole("form", { name: "New file" });
  await newFile.getByRole("textbox", { name: "Name" }).fill("memory.md");
  await newFile.getByRole("textbox", { name: "Text" }).fill("Last notes: 26.21\n");
  await newFile.getByRole("button", { name: "Save file" }).click();
  await folder.getByRole("button", { name: "memory.md", exact: true }).waitFor();
  const memory = await fetch(`${gateway.url}/api/store/automations/${automationId}/folder/memory.md`);
  assert.equal(await memory.text(), "Last notes: 26.21\n");
  await folder.getByRole("button", { name: "Edit memory.md" }).click();
  const editor = folder.getByRole("form", { name: "Edit memory.md" });
  await editor.getByRole("textbox", { name: "Text" }).fill("Last notes: 26.22\n");
  await editor.getByRole("button", { name: "Save file" }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(await (await fetch(`${gateway.url}/api/store/automations/${automationId}/folder/memory.md`)).text(), "Last notes: 26.22\n");
});

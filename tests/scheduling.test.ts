import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import type { Automation, AutomationDetail, Firing, Session, Task, Trigger } from "../shared/api.ts";
import { FakeModel } from "./fake-model.ts";
import { buildTestImage, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

// Each claim runs its own gateway, whose scheduler goes by the time the test sets (the harness's
// clock file). AUTO-2 and AUTO-8 start at 2030-01-07T06:00Z, a Monday: 07:00 in Budapest.
const MONDAY = "2030-01-07T06:00:00.000Z";

let scratch: string;
/** omp's agent directory for the gateways: the scripted model is the `tiny` role, which checks use. */
let agentDir: string;
let fake: FakeModel;

before(async () => {
  // Guards and checks run in the session image.
  await buildTestImage();
  scratch = mkdtempSync(join(tmpdir(), "am-scheduling-test-"));
  fake = await FakeModel.start();
  agentDir = join(scratch, "omp-agent");
  mkdirSync(agentDir);
  fake.writeAgentDir(agentDir);
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  tiny: fake/scripted\n");
}, { timeout: 300_000 });

after(async () => {
  await fake?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function gatewayWithProject(clock?: string): Promise<{ gateway: Gateway; projectId: string }> {
  const gateway = await Gateway.start({ runtime: "none", clock, env: { AGENTMONITOR_OMP_AGENT_DIR: agentDir } });
  const projectId = (await gateway.data<{ id: string }>("POST", "/projects", { name: "draftcoach" })).id;
  return { gateway, projectId };
}

/** An automation with one trigger, and files in its folder. */
async function automation(
  gateway: Gateway,
  projectId: string,
  name: string,
  trigger: { cron: string; timezone?: string; guardPath?: string; checkPath?: string },
  files: Record<string, string> = {},
): Promise<{ automation: Automation; trigger: Trigger }> {
  const created = await gateway.data<Automation>("POST", `/projects/${projectId}/automations`, { name, instructions: `Run ${name}.` });
  for (const [path, body] of Object.entries(files)) {
    assert.equal((await fetch(`${gateway.url}/api/store/automations/${created.id}/folder/${path}`, { method: "PUT", body })).status, 200);
  }
  return { automation: created, trigger: await gateway.data<Trigger>("POST", `/automations/${created.id}/triggers`, trigger) };
}

/** Resolves once the gateway says what became of the automation's firing for `scheduled`, with that line. */
function fired(gateway: Gateway, name: string, scheduled: string): Promise<string> {
  return gateway.logged(new RegExp(`automation "${name}" fired for ${scheduled.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}

spec("AUTO-2", "a schedule in its timezone fires once per time, also across a restart, and a time missed while down fires once when back", async () => {
  const { gateway, projectId } = await gatewayWithProject(MONDAY);
  try {
    // 08:00 every day, in Budapest (the default) and in UTC.
    const budapest = await automation(gateway, projectId, "Budapest", { cron: "0 8 * * *" });
    const utc = await automation(gateway, projectId, "UTC", { cron: "0 8 * * *", timezone: "UTC" });
    const firingsOf = (id: string) => gateway.data<Firing[]>("GET", `/automations/${id}/firings`);
    const endRun = async (id: string) => {
      const [run] = (await gateway.data<AutomationDetail>("GET", `/automations/${id}`)).runs;
      await gateway.data("POST", `/sessions/${run.id}/end`);
    };

    // 08:00 in Budapest is 07:00 UTC: the Budapest trigger fires on time, the UTC one not yet.
    gateway.setClock("2030-01-07T07:00:30.000Z");
    assert.match(await fired(gateway, "Budapest", "2030-01-07T07:00:00.000Z"), /: started/);
    const [onTime] = await firingsOf(budapest.automation.id);
    const [run] = (await gateway.data<AutomationDetail>("GET", `/automations/${budapest.automation.id}`)).runs;
    assert.deepEqual(
      [onTime.scheduledAt, onTime.caughtUp, onTime.outcome, onTime.sessionId, onTime.guard, onTime.check],
      [Date.parse("2030-01-07T07:00:00.000Z"), false, "started", run.id, null, null],
    );
    assert.equal(run.run?.startedBy, null, "a trigger started it, not a person");
    assert.deepEqual(await firingsOf(utc.automation.id), []);
    await endRun(budapest.automation.id);

    // A restart fires nothing again, neither at once nor later that day.
    await gateway.restart();
    gateway.setClock("2030-01-07T08:00:30.000Z");
    assert.match(await fired(gateway, "UTC", "2030-01-07T08:00:00.000Z"), /: started/);
    assert.deepEqual((await firingsOf(budapest.automation.id)).map((found) => found.id), [onTime.id]);
    await endRun(utc.automation.id);

    // Down over two days: each trigger fires once, for the latest time it missed, as caught up.
    await gateway.restart("2030-01-09T09:30:00.000Z");
    assert.match(await fired(gateway, "Budapest", "2030-01-09T07:00:00.000Z (caught up)"), /: started/);
    assert.match(await fired(gateway, "UTC", "2030-01-09T08:00:00.000Z (caught up)"), /: started/);
    const times = async (id: string) => (await firingsOf(id)).map((found) => [new Date(found.scheduledAt).toISOString(), found.caughtUp, found.outcome]);
    assert.deepEqual(await times(budapest.automation.id), [["2030-01-09T07:00:00.000Z", true, "started"], ["2030-01-07T07:00:00.000Z", false, "started"]]);
    assert.deepEqual(await times(utc.automation.id), [["2030-01-09T08:00:00.000Z", true, "started"], ["2030-01-07T08:00:00.000Z", false, "started"]]);

    // What is no schedule is refused.
    for (const cron of ["61 8 * * *", "0 8 * *", "0 8 * * * *", "@daily"]) {
      assert.equal((await gateway.api("POST", `/automations/${budapest.automation.id}/triggers`, { cron })).status, 400, cron);
    }
  } finally {
    await gateway.stop();
  }
});

spec("AUTO-8", "a firing runs its guard, then its check; a run starts only when both pass, and every firing records what they said", async () => {
  const { gateway, projectId } = await gatewayWithProject(MONDAY);
  try {
    const guarded = await automation(gateway, projectId, "Guarded", { cron: "0 8 * * *", guardPath: "guard.sh", checkPath: "check.md" }, {
      "guard.sh": "#!/bin/bash\necho no patch yet\nexit 1\n",
      "check.md": 'say:{"answer":"yes","why":"never-asked"}\n',
    });
    const checked = await automation(gateway, projectId, "Checked", { cron: "0 8 * * *", guardPath: "guard.sh", checkPath: "check.md" }, {
      "guard.sh": "echo patch 26.20\n",
      "check.md": 'say:{"answer":"no","why":"26.20-was-reviewed"}\n',
    });
    // The check answers from what the guard found: its output goes on to the check, and to the run.
    const passing = await automation(gateway, projectId, "Passing", { cron: "0 8 * * *", guardPath: "guard.sh", checkPath: "check.md" }, {
      "guard.sh": `echo 'say:{"answer":"yes","why":"26.21-is-new"}'\n`,
      "check.md": "Is the patch the guard found new?\n",
    });

    gateway.setClock("2030-01-07T07:00:30.000Z");
    const scheduled = "2030-01-07T07:00:00.000Z";
    await Promise.all([fired(gateway, "Guarded", scheduled), fired(gateway, "Checked", scheduled), fired(gateway, "Passing", scheduled)]);
    const outcome = async (id: string) => {
      const [firing] = await gateway.data<Firing[]>("GET", `/automations/${id}/firings`);
      return { firing, runs: (await gateway.data<AutomationDetail>("GET", `/automations/${id}`)).runs };
    };

    // The guard fails: exit 1, with what it printed; the check never runs, nor a run.
    const stopped = await outcome(guarded.automation.id);
    assert.deepEqual([stopped.firing.outcome, stopped.firing.guard, stopped.firing.check, stopped.runs], ["guard", { passed: false, output: "no patch yet\nexit 1" }, null, []]);

    // The guard passes and the check says no, with why.
    const refused = await outcome(checked.automation.id);
    assert.deepEqual(
      [refused.firing.outcome, refused.firing.guard, refused.firing.check, refused.runs],
      ["check", { passed: true, output: "patch 26.20\n" }, { passed: false, output: "26.20-was-reviewed" }, []],
    );

    // Both pass: a run starts, its prompt holding the time and what they said.
    const started = await outcome(passing.automation.id);
    const guard = { passed: true, output: `say:{"answer":"yes","why":"26.21-is-new"}\n` };
    const check = { passed: true, output: "26.21-is-new" };
    assert.deepEqual([started.firing.outcome, started.firing.guard, started.firing.check, started.firing.sessionId], ["started", guard, check, started.runs[0]?.id]);
    const context = started.runs[0].run?.triggerContext ?? "";
    assert.match(context, /`0 8 \* \* \*` \(Europe\/Budapest\), for 2030-01-07 08:00 there \(2030-01-07T07:00:00\.000Z\)\./);
    assert.ok(context.includes(`passed. What it printed:\n\n~~~~\nsay:{"answer":"yes","why":"26.21-is-new"}\n~~~~`), context);
    assert.match(context, /check, `check\.md` in the folder, said yes: 26\.21-is-new/);

    // Agents see the firings with am.
    const task = await gateway.data<Task>("POST", `/projects/${projectId}/tasks`, { title: "Patch review setup" });
    const agent = await gateway.data<Session>("POST", `/tasks/${task.id}/sessions`, {});
    const shown = gateway.am(agent.id, ["automation", "show", "Checked"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /firings:\n {2}2030-01-07T07:00:00\.000Z\tcheck\tguard passed\tcheck: no, 26\.20-was-reviewed/);
  } finally {
    await gateway.stop();
  }
});

spec("AUTO-9", "a firing while a run of the automation is still going is skipped and recorded as such", async () => {
  // The run going started by the real time, and keeps within its time limit (AUTO-14) only if the
  // firing comes soon after: the next minute, in UTC.
  const start = Date.now();
  const { gateway, projectId } = await gatewayWithProject(new Date(start).toISOString());
  try {
    const next = new Date(Math.floor(start / 60_000) * 60_000 + 60_000);
    const cron = `${next.getUTCMinutes()} ${next.getUTCHours()} * * *`;
    const busy = await automation(gateway, projectId, "Busy", { cron, timezone: "UTC", guardPath: "guard.sh" }, { "guard.sh": "echo would pass\n" });
    const going = await gateway.data<Session>("POST", `/automations/${busy.automation.id}/runs`, {});
    gateway.setClock(new Date(next.getTime() + 30_000).toISOString());
    assert.match(await fired(gateway, "Busy", next.toISOString()), /: running/);
    const [firing] = await gateway.data<Firing[]>("GET", `/automations/${busy.automation.id}/firings`);
    // Skipped before its guard ran; the run going is still the only one.
    assert.deepEqual([firing.outcome, firing.guard, firing.check, firing.sessionId], ["running", null, null, null]);
    assert.deepEqual((await gateway.data<AutomationDetail>("GET", `/automations/${busy.automation.id}`)).runs.map((run) => run.id), [going.id]);
  } finally {
    await gateway.stop();
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spec } from "./spec.ts";

const checker = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "spec-check.ts");

function project(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spec-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function cli(root: string, ...args: string[]): { code: number; output: string } {
  const result = spawnSync(process.execPath, [checker, "--root", root, ...args], { encoding: "utf8" });
  return { code: result.status ?? -1, output: result.stdout + result.stderr };
}

const twoClaims = "## Area\n\n- **A-1** First claim.\n- **A-2** Second claim\n  continues here.\n";
const coversA1 = 'import { spec } from "./spec.ts";\nspec("A-1", "first", () => { return 1; });\n';

spec("SPEC-1", "uncovered claim warns, strict fails", (t) => {
  const root = project(t, { "SPEC.md": twoClaims, "tests/a.test.ts": coversA1 });
  assert.equal(cli(root, "--update").code, 0);

  const loose = cli(root);
  assert.equal(loose.code, 0);
  assert.match(loose.output, /warning: claim A-2 has no test/);
  assert.doesNotMatch(loose.output, /A-1 has no test/);

  const strict = cli(root, "--strict");
  assert.equal(strict.code, 1);
  assert.match(strict.output, /warning: claim A-2 has no test/);
});

spec("SPEC-2", "test referencing unknown claim fails", (t) => {
  const root = project(t, {
    "SPEC.md": twoClaims,
    "tests/a.test.ts": 'spec("A-9", "ghost", () => {});\nconst s = \'spec("A-8", "inside a string", () => {})\';\n',
  });
  const result = cli(root);
  assert.equal(result.code, 1);
  assert.match(result.output, /references unknown claim A-9/);
  assert.doesNotMatch(result.output, /A-8/);
  assert.equal(cli(root, "--update").code, 1, "lock must refuse while a test points at an unknown claim");
});

spec("SPEC-3", "claim or test drift fails until relocked", (t) => {
  const root = project(t, { "SPEC.md": twoClaims, "tests/a.test.ts": coversA1 });
  assert.equal(cli(root, "--update").code, 0);
  assert.equal(cli(root).code, 0);

  write(root, { "SPEC.md": twoClaims.replace("First claim.", "First claim, reworded.") });
  const claimChanged = cli(root);
  assert.equal(claimChanged.code, 1);
  assert.match(claimChanged.output, /drift: claim A-1 text changed/);
  assert.equal(cli(root, "--update").code, 0);
  assert.equal(cli(root).code, 0);

  write(root, { "tests/a.test.ts": coversA1.replace("return 1", "return 2") });
  const testChanged = cli(root);
  assert.equal(testChanged.code, 1);
  assert.match(testChanged.output, /drift: test tests\/a\.test\.ts::A-1::first changed/);
  assert.equal(cli(root, "--update").code, 0);

  write(root, { "tests/b.test.ts": 'spec("A-2", "second", () => {});\n' });
  assert.match(cli(root).output, /drift: test tests\/b\.test\.ts::A-2::second added/);
  assert.equal(cli(root, "--update").code, 0);

  rmSync(join(root, "tests/b.test.ts"));
  const testRemoved = cli(root);
  assert.equal(testRemoved.code, 1);
  assert.match(testRemoved.output, /drift: test tests\/b\.test\.ts::A-2::second removed/);

  write(root, { "SPEC.md": twoClaims.replace("continues here.", "continues   here.") });
  assert.doesNotMatch(cli(root).output, /claim A-2 text changed/, "whitespace-only edits are not drift");
});

spec("SPEC-4", "deleted claim ids are retired and cannot be reused", (t) => {
  const root = project(t, { "SPEC.md": twoClaims, "tests/a.test.ts": coversA1 });
  assert.equal(cli(root, "--update").code, 0);

  write(root, { "SPEC.md": "## Area\n\n- **A-1** First claim.\n" });
  assert.match(cli(root).output, /drift: claim A-2 removed/);
  assert.equal(cli(root, "--update").code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "spec.lock.json"), "utf8")).retired, ["A-2"]);

  write(root, { "SPEC.md": "## Area\n\n- **A-1** First claim.\n- **A-2** A new meaning.\n" });
  const reused = cli(root);
  assert.equal(reused.code, 1);
  assert.match(reused.output, /claim A-2 reuses a retired id/);
  assert.equal(cli(root, "--update").code, 1);
});

spec("SPEC-5", "duplicate claim ids fail", (t) => {
  const root = project(t, {
    "SPEC.md": "## Area\n\n- **A-1** One.\n\n## Other\n\n- **A-1** Two.\n",
    "tests/a.test.ts": coversA1,
  });
  const result = cli(root);
  assert.equal(result.code, 1);
  assert.match(result.output, /duplicate claim A-1/);
  assert.equal(cli(root, "--update").code, 1);
});

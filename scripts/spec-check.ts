import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Lock {
  claims: Record<string, string>;
  tests: Record<string, string>;
  retired: string[];
}

export interface TestRef {
  file: string;
  id: string;
  title: string;
  hash: string;
}

export interface Report {
  errors: string[];
  warnings: string[];
  next: Lock;
}

const idPattern = /^[A-Z][A-Z0-9]*-[1-9]\d*$/;
const claimLine = /^- \*\*([^*]+)\*\*\s+(.*)$/;

function hash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function parseClaims(spec: string): { claims: Map<string, string>; errors: string[] } {
  const claims = new Map<string, string>();
  const errors: string[] = [];
  let current: { id: string; text: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    if (claims.has(current.id)) errors.push(`duplicate claim ${current.id}`);
    else claims.set(current.id, current.text.join(" "));
    current = null;
  };
  for (const line of spec.split(/\r?\n/)) {
    const match = claimLine.exec(line);
    if (match) {
      flush();
      if (!idPattern.test(match[1])) {
        errors.push(`malformed claim id ${match[1]}`);
        continue;
      }
      current = { id: match[1], text: [match[2]] };
    } else if (current && /^ {2}\S/.test(line)) {
      current.text.push(line.trim());
    } else {
      flush();
    }
  }
  flush();
  return { claims, errors };
}

/**
 * Blanks string, template, comment, and regex contents so `spec(` is only found
 * in code and parentheses inside literals cannot unbalance a call. Template
 * `${}` expressions are blanked too: spec calls there are not supported.
 */
function maskSource(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let lastSignificant = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < source.length) {
        if (source[j] === "\\") j += 2;
        else if (c === "`" && source[j] === "$" && source[j + 1] === "{") { depth++; j += 2; }
        else if (c === "`" && depth > 0 && source[j] === "}") { depth--; j++; }
        else if (depth === 0 && source[j] === c) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = c;
    } else if (c === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") j += 2;
        else if (source[j] === "[") { inClass = true; j++; }
        else if (source[j] === "]") { inClass = false; j++; }
        else if (source[j] === "/" && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = "/";
    } else {
      if (!/\s/.test(c)) lastSignificant = c;
      i++;
    }
  }
  return out.join("");
}

const callArgs = /^\(\s*(["'`])([^"'`]*)\1\s*,\s*(["'`])((?:\\.|(?!\3)[^\\])*)\3/;

export function parseTestRefs(file: string, source: string): { refs: TestRef[]; errors: string[] } {
  const masked = maskSource(source);
  const refs: TestRef[] = [];
  const errors: string[] = [];
  for (const match of masked.matchAll(/(?<![\w$.])spec\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < masked.length; k++) {
      const c = masked[k];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) { close = k; break; }
      }
    }
    const line = source.slice(0, match.index).split("\n").length;
    if (close === -1) {
      errors.push(`${file}:${line}: unterminated spec() call`);
      continue;
    }
    const args = callArgs.exec(source.slice(open, close + 1));
    if (!args) {
      errors.push(`${file}:${line}: spec() needs literal id and title arguments`);
      continue;
    }
    refs.push({ file, id: args[2], title: args[4], hash: hash(source.slice(match.index, close + 1)) });
  }
  return { refs, errors };
}

export function check(spec: string, testFiles: Map<string, string>, lock: Lock): Report {
  const { claims, errors } = parseClaims(spec);
  const warnings: string[] = [];
  const retired = new Set(lock.retired);
  for (const id of claims.keys()) {
    if (retired.has(id)) errors.push(`claim ${id} reuses a retired id`);
  }

  const tests = new Map<string, TestRef>();
  const covered = new Set<string>();
  for (const [file, source] of testFiles) {
    const parsed = parseTestRefs(file, source);
    errors.push(...parsed.errors);
    for (const ref of parsed.refs) {
      const key = `${ref.file}::${ref.id}::${ref.title}`;
      if (tests.has(key)) errors.push(`duplicate test ${key}`);
      tests.set(key, ref);
      if (claims.has(ref.id)) covered.add(ref.id);
      else if (retired.has(ref.id)) errors.push(`${key} references retired claim ${ref.id}`);
      else errors.push(`${key} references unknown claim ${ref.id}`);
    }
  }

  for (const id of claims.keys()) {
    if (!covered.has(id)) warnings.push(`claim ${id} has no test`);
  }

  const nextClaims: Record<string, string> = {};
  for (const [id, text] of claims) {
    const digest = hash(text);
    nextClaims[id] = digest;
    if (!(id in lock.claims)) errors.push(`drift: claim ${id} added`);
    else if (lock.claims[id] !== digest) errors.push(`drift: claim ${id} text changed`);
  }
  for (const id of Object.keys(lock.claims)) {
    if (!claims.has(id)) errors.push(`drift: claim ${id} removed`);
  }

  const nextTests: Record<string, string> = {};
  for (const [key, ref] of tests) {
    nextTests[key] = ref.hash;
    if (!(key in lock.tests)) errors.push(`drift: test ${key} added`);
    else if (lock.tests[key] !== ref.hash) errors.push(`drift: test ${key} changed`);
  }
  for (const key of Object.keys(lock.tests)) {
    if (!tests.has(key)) errors.push(`drift: test ${key} removed`);
  }

  const removed = Object.keys(lock.claims).filter((id) => !claims.has(id));
  const next: Lock = {
    claims: nextClaims,
    tests: nextTests,
    retired: [...new Set([...lock.retired, ...removed])].sort(),
  };
  return { errors, warnings, next };
}

function collectTests(root: string, dir: string, out: Map<string, string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") collectTests(root, path, out);
    } else if (/\.test\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
      out.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  }
}

export function run(root: string, args: string[]): number {
  const strict = args.includes("--strict");
  const update = args.includes("--update");
  const lockPath = join(root, "spec.lock.json");
  const lock: Lock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, "utf8"))
    : { claims: {}, tests: {}, retired: [] };
  const testFiles = new Map<string, string>();
  collectTests(root, join(root, "tests"), testFiles);
  const report = check(readFileSync(join(root, "SPEC.md"), "utf8"), testFiles, lock);

  const structural = report.errors.filter((e) => !e.startsWith("drift: "));
  if (update) {
    if (structural.length > 0) {
      for (const e of structural) console.error(`error: ${e}`);
      console.error("spec:lock refused: fix the errors above first");
      return 1;
    }
    writeFileSync(lockPath, `${JSON.stringify(report.next, null, 2)}\n`);
    for (const w of report.warnings) console.warn(`warning: ${w}`);
    console.log(`spec.lock.json updated: ${Object.keys(report.next.claims).length} claims, ${Object.keys(report.next.tests).length} tests`);
    return 0;
  }

  for (const e of report.errors) console.error(`error: ${e}`);
  for (const w of report.warnings) console.warn(`warning: ${w}`);
  const failed = report.errors.length > 0 || (strict && report.warnings.length > 0);
  if (report.errors.some((e) => e.startsWith("drift: "))) {
    console.error("review the drifted claim/test pairs, then run npm run spec:lock");
  }
  console.log(`${failed ? "FAIL" : "ok"}: ${report.errors.length} errors, ${report.warnings.length} warnings`);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];
  process.exitCode = run(root, process.argv.slice(2));
}

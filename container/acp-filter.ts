// Tern's agent command for omp: runs `omp acp` and passes its messages to Tern unchanged, except
// search results. Tern 0.9.4 builds a tree for a glob or grep result from the result's details
// (`files`, `fileMatches`, `displayContent`) and its text. When two children of one node get the
// same key (a file name in two folders; a grep match line, by a rule not worked out) the tree
// fails with `duplicate child key` and Tern draws nothing after that tool call. So search results
// go to Tern without those details; a glob's text as full paths, one per line, which Tern draws as
// a correct tree; a grep as a plain tool (kind "other"), which Tern draws as text. Checked against
// sessions that failed (DraftCoach's ads, jogi, worlds-2026) and AGENT-6. Reported as
// stencil-hq/tern-sdk#99; remove this once Tern draws such results.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

/** One message from omp (a JSON-RPC line), rewritten if it is a search result. */
function forTern(line: string): string {
  if (!line.includes('"files"') && !line.includes('"search"')) return line;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof message !== "object" || message === null || !("params" in message)) return line;
  const { params } = message;
  if (typeof params !== "object" || params === null || !("update" in params)) return line;
  const { update } = params;
  if (typeof update !== "object" || update === null) return line;
  // A grep call (a search with a pattern) goes to Tern as a plain tool, which Tern draws as text.
  if ("kind" in update && update.kind === "search" && "rawInput" in update
    && typeof update.rawInput === "object" && update.rawInput !== null && "pattern" in update.rawInput) {
    Reflect.set(update, "kind", "other");
    return JSON.stringify(message);
  }
  // A tool result: params.update.rawOutput.details.files.
  if (!("rawOutput" in update)) return line;
  const { rawOutput } = update;
  if (typeof rawOutput !== "object" || rawOutput === null || !("details" in rawOutput)) return line;
  const { details } = rawOutput;
  if (typeof details !== "object" || details === null || !("files" in details)) return line;
  const { files } = details;
  if (!Array.isArray(files)) return line;

  const grep = "fileMatches" in details;
  for (const key of ["files", "fileMatches", "displayContent"]) Reflect.deleteProperty(details, key);
  if (grep) return JSON.stringify(message);

  // A glob's text lists the files under folder headings, then notes after a blank line (a result
  // limit). omp sends it twice: rawOutput.content[] {type, text} and content[] {type, content: {type, text}}.
  const paths = files.filter((file) => typeof file === "string").join("\n");
  const texts = [
    ...("content" in rawOutput && Array.isArray(rawOutput.content) ? rawOutput.content : []),
    ...("content" in update && Array.isArray(update.content)
      ? update.content.map((block: unknown) => typeof block === "object" && block !== null && "content" in block ? block.content : null)
      : []),
  ];
  for (const block of texts) {
    if (typeof block !== "object" || block === null || !("text" in block) || typeof block.text !== "string") continue;
    const notes = block.text.indexOf("\n\n");
    Reflect.set(block, "text", notes === -1 ? paths : paths + block.text.slice(notes));
  }
  return JSON.stringify(message);
}

// Tern writes to omp directly; only omp's output passes through here. AGENTMONITOR_CHAT names this
// process as the chat omp's parent, so its extension takes the session's channel and nothing the
// agent starts does (container/omp-extension.ts).
const omp = spawn("omp", ["acp", "--auto-approve"], {
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env, AGENTMONITOR_CHAT: String(process.pid) },
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => omp.kill(signal));
const exited = once(omp, "exit");
for await (const line of createInterface({ input: omp.stdout, crlfDelay: Infinity })) {
  if (!process.stdout.write(`${forTern(line)}\n`)) await once(process.stdout, "drain");
}
const [code, signal] = await exited;
process.exitCode = typeof code === "number" ? code : signal === null ? 0 : 1;

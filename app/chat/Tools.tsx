import { useEffect, useState, type ReactNode } from "react";
import { contentOf, isRecord, num, records, str, strings, type ImageBlock, type Json, type ToolView } from "./transcript.ts";

/** Elapsed time as the tool line shows it: `0.4s`, `12s`, `1m 05s`, `2h 03m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** CHAT-2: how long a call ran, or has run so far; it ticks while the call runs. */
function Timer({ startedAt, endedAt, running }: { startedAt: number | null; endedAt: number | null; running: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || startedAt === null) return;
    let timer: number | undefined;
    const tick = () => {
      setNow(Date.now());
      // Tenths while they show, then seconds.
      timer = window.setTimeout(tick, Date.now() - startedAt < 10_000 ? 100 : 1000);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [running, startedAt]);
  const elapsed = startedAt === null ? null : running ? now - startedAt : endedAt === null ? null : endedAt - startedAt;
  return <span role="timer" className="tool-timer">{elapsed === null ? "" : formatElapsed(elapsed)}</span>;
}

function firstLine(text: string | null): string {
  return (text ?? "").trim().split("\n")[0] ?? "";
}

/** The file an `edit` call changes: its `path`, or the `[path#TAG]` header of omp's hashline patch. */
function editPath(tool: ToolView): string {
  const details = isRecord(tool.output?.details) ? tool.output.details : {};
  return str(tool.args.path) ?? str(details.path) ?? /^\[\s*([^\]#\n]+?)\s*#/m.exec(str(tool.args.input) ?? "")?.[1] ?? "";
}

/** What a call works on, for its one line: a command, a path, a pattern, its subagents. */
function subjectOf(tool: ToolView): string {
  const { args } = tool;
  switch (tool.name) {
    case "bash":
      return firstLine(str(args.command));
    case "read":
    case "write":
      return str(args.path) ?? "";
    case "edit":
      return editPath(tool);
    case "grep":
      return `${str(args.pattern) ?? ""}${str(args.path) === null ? "" : ` in ${str(args.path)}`}`;
    case "glob":
    case "find":
      return str(args.path) ?? str(args.pattern) ?? str(args.query) ?? "";
    case "task": {
      const tasks = records(args.tasks);
      const names = tasks.map((task) => str(task.name) ?? str(task.agent) ?? "task").join(", ");
      return `${tasks.length} ${tasks.length === 1 ? "subagent" : "subagents"}${names === "" ? "" : `: ${names}`}`;
    }
    case "todo":
      return [str(args.op), str(args.task)].filter((part) => part !== null).join(" ");
    case "ask":
      return records(args.questions).map((question) => str(question.question)).filter((text) => text !== null).join(" / ");
    case "web_search":
      return str(args.query) ?? "";
    default:
      return tool.intent ?? firstLine(Object.values(args).find((value): value is string => typeof value === "string") ?? "");
  }
}

/** The call's input without omp's `i` (the intent the line already shows). */
function inputOf(args: Json): Json {
  const { i: _intent, ...rest } = args;
  return rest;
}

/** Where an image block's bytes are: inline, or a blob omp moved out of its session file. */
export type ImageUrl = (image: ImageBlock) => string;

export function ChatImages({ images, imageUrl }: { images: ImageBlock[]; imageUrl: ImageUrl }) {
  if (images.length === 0) return null;
  return (
    <div className="chat-images">
      {images.map((image, index) => (
        <a key={index} href={imageUrl(image)} target="_blank" rel="noreferrer">
          <img className="chat-image" src={imageUrl(image)} alt={`Image ${index + 1}`} />
        </a>
      ))}
    </div>
  );
}

function Output({ text, label = "Output" }: { text: string; label?: string }) {
  if (text === "") return null;
  return (
    <div className="tool-part">
      <h4>{label}</h4>
      <pre className="tool-output">{text}</pre>
    </div>
  );
}

/** omp's edit diff: lines `+N|`, `-N|`, ` N|`. */
function Diff({ diff }: { diff: string }) {
  return (
    <pre className="tool-output diff">
      {diff.split("\n").map((line, index) => (
        <span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : undefined}>{line}{"\n"}</span>
      ))}
    </pre>
  );
}

const TODO_MARKS: Record<string, string> = { completed: "✓", in_progress: "◐", pending: "○", abandoned: "–", blocked: "!" };

function Todos({ phases }: { phases: Json[] }) {
  return (
    <div className="tool-part todo">
      {phases.map((phase, index) => (
        <div key={index}>
          <h4>{str(phase.name) ?? "Todos"}</h4>
          <ul className="todo-list">
            {records(phase.tasks).map((task, taskIndex) => {
              const status = str(task.status) ?? "pending";
              return (
                <li key={taskIndex} className={`todo-${status}`}>
                  <span className="todo-mark" aria-hidden="true">{TODO_MARKS[status] ?? "○"}</span>
                  <span>{str(task.content) ?? ""}</span>
                  {status !== "pending" && status !== "completed" && <span className="muted small"> ({status.replace("_", " ")})</span>}
                  {str(task.blocker) !== null && <span className="muted small">: {str(task.blocker)}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A `task` call's subagents: what each was asked, how far it got, and what it answered. */
function Subagents({ tool, details }: { tool: ToolView; details: Json }) {
  const asked = records(tool.args.tasks);
  const results = records(details.results);
  const progress = records(details.progress);
  const count = Math.max(asked.length, results.length, progress.length, tool.subagents.length);
  const rows = Array.from({ length: count }, (_, index) => {
    const live = tool.subagents[index] ?? {};
    const liveProgress = isRecord(live.progress) ? live.progress : {};
    const result = results[index] ?? {};
    const snapshot = progress[index] ?? {};
    const task = asked[index] ?? {};
    const pick = (field: string) => result[field] ?? liveProgress[field] ?? snapshot[field] ?? live[field] ?? task[field];
    const status = str(result.error) !== null || result.aborted === true
      ? "failed"
      : results[index] !== undefined ? "done" : str(live.status) ?? str(liveProgress.status) ?? str(snapshot.status) ?? (tool.running ? "pending" : "");
    return {
      name: str(pick("id")) ?? str(task.name) ?? `#${index + 1}`,
      agent: str(pick("agent")),
      status,
      doing: str(liveProgress.currentTool) === null ? str(liveProgress.lastIntent) : `${str(liveProgress.currentTool)}${str(liveProgress.currentToolIntent) === null ? "" : `: ${str(liveProgress.currentToolIntent)}`}`,
      tokens: num(pick("tokens")),
      durationMs: num(pick("durationMs")),
      assignment: str(task.task) ?? str(pick("assignment")) ?? str(pick("task")),
      output: str(result.output) ?? str(result.error),
      // While it runs, the last lines it wrote.
      recent: strings(liveProgress.recentOutput).slice(-5).join("\n"),
    };
  });
  if (rows.length === 0) return null;
  return (
    <ul className="subagents">
      {rows.map((row, index) => (
        <li key={index} className="subagent">
          <div className="subagent-line">
            <strong>{row.name}</strong>
            {row.agent !== null && <span className="muted small">{row.agent}</span>}
            {row.status !== "" && <span className={`subagent-status subagent-${row.status}`}>{row.status}</span>}
            {row.doing !== null && <span className="subagent-doing">{row.doing}</span>}
            <span className="subagent-meta muted small">
              {[row.tokens === null || row.tokens === 0 ? null : `${Math.round(row.tokens / 100) / 10}k tokens`, row.durationMs === null || row.durationMs === 0 ? null : formatElapsed(row.durationMs)].filter((part) => part !== null).join(" · ")}
            </span>
          </div>
          {row.assignment !== null && (
            <details className="subagent-part">
              <summary>Assignment</summary>
              <pre className="tool-output">{row.assignment}</pre>
            </details>
          )}
          {row.output !== null
            ? <pre className="tool-output subagent-answer">{row.output}</pre>
            : row.recent !== "" && <pre className="tool-output subagent-answer">{row.recent}</pre>}
        </li>
      ))}
    </ul>
  );
}

/** An `ask` call's questions with the answers given, as omp's details hold them. */
function Questions({ tool, details }: { tool: ToolView; details: Json }) {
  const answers = records(details.results).length > 0 ? records(details.results) : str(details.question) === null ? [] : [details];
  const questions = records(tool.args.questions);
  return (
    <ul className="ask-questions">
      {questions.map((question, index) => {
        const answer = answers.find((candidate) => candidate.id === question.id) ?? answers[index];
        const chosen = answer === undefined ? [] : strings(answer.selectedOptions);
        const custom = answer === undefined ? null : str(answer.customInput);
        return (
          <li key={index}>
            <strong>{str(question.question) ?? ""}</strong>
            <ul className="ask-options">
              {records(question.options).map((option, optionIndex) => {
                const label = str(option.label) ?? "";
                return <li key={optionIndex} className={chosen.includes(label) ? "chosen" : undefined}>{chosen.includes(label) ? "● " : "○ "}{label}</li>;
              })}
              {custom !== null && <li className="chosen">● {custom}</li>}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function ToolBody({ tool, imageUrl }: { tool: ToolView; imageUrl: ImageUrl }) {
  const { text, images } = contentOf(tool.output?.content);
  const details = isRecord(tool.output?.details) ? tool.output.details : {};
  const input = inputOf(tool.args);
  let body: ReactNode;
  switch (tool.name) {
    case "bash": {
      const exitCode = num(details.exitCode);
      body = (
        <>
          <pre className="tool-output command">$ {str(tool.args.command) ?? ""}</pre>
          <Output text={text} />
          {exitCode !== null && exitCode !== 0 && <p className="tool-error-text">Exit code {exitCode}</p>}
        </>
      );
      break;
    }
    case "edit": {
      const diff = str(details.diff);
      body = (
        <>
          <p className="tool-path">{editPath(tool)}</p>
          {diff === null ? <Output text={str(tool.args.input) ?? JSON.stringify(input, null, 2)} label="Input" /> : <Diff diff={diff} />}
          {(diff === null || tool.isError) && <Output text={text} />}
        </>
      );
      break;
    }
    case "read":
      body = (
        <>
          <p className="tool-path">{str(details.resolvedPath) ?? str(tool.args.path) ?? ""}</p>
          <Output text={text} label="Content" />
        </>
      );
      break;
    case "write":
      body = (
        <>
          <p className="tool-path">{str(details.resolvedPath) ?? str(tool.args.path) ?? ""}</p>
          <Output text={str(tool.args.content) ?? ""} label="Content" />
          {tool.isError && <Output text={text} />}
        </>
      );
      break;
    case "grep":
    case "glob":
    case "find":
      body = (
        <>
          <dl className="tool-args">
            {Object.entries(input).map(([name, value]) => (
              <div key={name}><dt>{name}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>
            ))}
          </dl>
          <Output text={str(details.displayContent) ?? text} label="Results" />
        </>
      );
      break;
    case "task":
      body = (
        <>
          {str(tool.args.context) !== null && (
            <details className="subagent-part">
              <summary>Context</summary>
              <pre className="tool-output">{str(tool.args.context)}</pre>
            </details>
          )}
          <Subagents tool={tool} details={details} />
          {records(details.results).length === 0 && <Output text={text} />}
        </>
      );
      break;
    case "todo": {
      const phases = records(details.phases);
      body = phases.length > 0 ? <Todos phases={phases} /> : <Output text={text} />;
      break;
    }
    case "ask":
      body = (
        <>
          <Questions tool={tool} details={details} />
          {(tool.isError || records(details.results).length + (str(details.question) === null ? 0 : 1) === 0) && <Output text={text} />}
        </>
      );
      break;
    default:
      body = (
        <>
          <Output text={Object.keys(input).length === 0 ? "" : JSON.stringify(input, null, 2)} label="Input" />
          <Output text={text} />
        </>
      );
  }
  return (
    <>
      {body}
      <ChatImages images={images} imageUrl={imageUrl} />
    </>
  );
}

/** CHAT-2: a tool call, one line until clicked; then its input and output. */
export function ToolCall({ tool, imageUrl }: { tool: ToolView; imageUrl: ImageUrl }) {
  const [open, setOpen] = useState(false);
  const subject = subjectOf(tool);
  const state = tool.running ? "running" : tool.isError ? "error" : tool.output === null ? "pending" : "done";
  return (
    <div className={`tool tool-${state}`}>
      <button type="button" className="tool-line" aria-expanded={open} onClick={() => setOpen(!open)} title={tool.intent ?? undefined}>
        <span className="tool-mark" aria-hidden="true" />
        <span className="tool-name">{tool.name}</span>
        {subject !== "" && <span className="tool-subject"> {subject}</span>}
        {tool.isError && <span className="tool-failed"> failed</span>}
        {" "}
        <Timer startedAt={tool.startedAt} endedAt={tool.endedAt} running={tool.running} />
      </button>
      {open && (
        <div role="region" aria-label={`${tool.name} details`} className="tool-body">
          {tool.intent !== null && <p className="tool-intent muted small">{tool.intent}</p>}
          <ToolBody tool={tool} imageUrl={imageUrl} />
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import type { OmpFrame } from "../../shared/chat.ts";
import { num, records, str, strings } from "./transcript.ts";

/** The answer to a dialog, as omp's `extension_ui_response` without its `type` and `id`. */
export type DialogAnswer = Record<string, unknown>;

/** AGENT-5: an `ask` with every question; one single-choice question answers with one click. */
function Ask({ dialog, onAnswer }: { dialog: OmpFrame; onAnswer: (answer: DialogAnswer) => void }) {
  const questions = records(dialog.questions);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const oneClick = questions.length === 1 && questions[0]?.multi !== true;
  const answers = () => questions.map((question) => {
    const id = str(question.id) ?? "";
    const text = (custom[id] ?? "").trim();
    // A single choice takes an option or a typed answer, not both.
    return question.multi !== true && text !== ""
      ? { id, selectedOptions: [], customInput: text }
      : { id, selectedOptions: chosen[id] ?? [], ...(text === "" ? {} : { customInput: text }) };
  });
  const pick = (id: string, label: string, multi: boolean) => {
    if (oneClick) {
      onAnswer({ answers: [{ id, selectedOptions: [label] }] });
      return;
    }
    const before = chosen[id] ?? [];
    setChosen({ ...chosen, [id]: multi ? (before.includes(label) ? before.filter((item) => item !== label) : [...before, label]) : [label] });
  };
  return (
    <>
      {questions.map((question, index) => {
        const id = str(question.id) ?? String(index);
        const multi = question.multi === true;
        const recommended = num(question.recommended);
        return (
          <fieldset key={id} className="agent-question">
            {str(question.header) !== null && <legend>{str(question.header)}</legend>}
            <p className="agent-question-text">{str(question.question) ?? ""}</p>
            <div className="agent-options">
              {records(question.options).map((option, optionIndex) => {
                const label = str(option.label) ?? "";
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    className={optionIndex === recommended ? "agent-option recommended" : "agent-option"}
                    aria-pressed={oneClick ? undefined : (chosen[id] ?? []).includes(label)}
                    title={str(option.description) ?? undefined}
                    onClick={() => pick(id, label, multi)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <input
              aria-label={`Other answer to ${str(question.question) ?? "the question"}`}
              placeholder="Or type an answer"
              value={custom[id] ?? ""}
              onChange={(event) => setCustom({ ...custom, [id]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && oneClick && (custom[id] ?? "").trim() !== "") onAnswer({ answers: answers() });
              }}
            />
          </fieldset>
        );
      })}
      <div className="actions">
        {(!oneClick || Object.values(custom).some((text) => text.trim() !== "")) && <button type="button" className="send" onClick={() => onAnswer({ answers: answers() })}>Answer</button>}
        <button type="button" className="ghost" onClick={() => onAnswer({ cancelled: true })}>Dismiss</button>
      </div>
    </>
  );
}

function TextAnswer({ dialog, multiline, onAnswer }: { dialog: OmpFrame; multiline: boolean; onAnswer: (answer: DialogAnswer) => void }) {
  const [value, setValue] = useState(str(dialog.prefill) ?? "");
  return (
    <form className="agent-text-answer" onSubmit={(event) => { event.preventDefault(); onAnswer({ value }); }}>
      {multiline
        ? <textarea aria-label="Answer" rows={6} value={value} onChange={(event) => setValue(event.target.value)} />
        : <input aria-label="Answer" placeholder={str(dialog.placeholder) ?? undefined} value={value} onChange={(event) => setValue(event.target.value)} />}
      <div className="actions">
        <button type="submit">Answer</button>
        <button type="button" className="ghost" onClick={() => onAnswer({ cancelled: true })}>Dismiss</button>
      </div>
    </form>
  );
}

/** What a dialog is named by: its question(s) or its title. */
function titleOf(dialog: OmpFrame): string {
  if (dialog.method === "ask") return records(dialog.questions).map((question) => str(question.question) ?? "").join(" / ");
  return str(dialog.title) ?? str(dialog.message) ?? "The agent asks";
}

/** AGENT-5: an open omp dialog (ask, select, confirm, input, editor), answered by whoever answers first on any page. */
export function AgentDialog({ dialog, onAnswer }: { dialog: OmpFrame; onAnswer: (answer: DialogAnswer) => void }) {
  const title = titleOf(dialog);
  let body;
  switch (dialog.method) {
    case "ask":
      body = <Ask dialog={dialog} onAnswer={onAnswer} />;
      break;
    case "select": {
      const details = records(dialog.optionDetails);
      body = (
        <div className="agent-options">
          {strings(dialog.options).map((option, index) => (
            <button key={index} type="button" className="agent-option" title={str(details[index]?.description) ?? undefined} onClick={() => onAnswer({ value: option })}>{option}</button>
          ))}
          <button type="button" className="ghost" onClick={() => onAnswer({ cancelled: true })}>Dismiss</button>
        </div>
      );
      break;
    }
    case "confirm":
      body = (
        <div className="agent-options">
          <button type="button" className="agent-option" onClick={() => onAnswer({ confirmed: true })}>Yes</button>
          <button type="button" className="agent-option" onClick={() => onAnswer({ confirmed: false })}>No</button>
        </div>
      );
      break;
    default:
      body = <TextAnswer dialog={dialog} multiline={dialog.method === "editor"} onAnswer={onAnswer} />;
  }
  return (
    <section role="dialog" aria-label={title} className="agent-dialog">
      {dialog.method !== "ask" && <p className="agent-question-text">{title}</p>}
      {dialog.method === "confirm" && str(dialog.message) !== null && str(dialog.title) !== null && <p>{str(dialog.message)}</p>}
      {body}
    </section>
  );
}

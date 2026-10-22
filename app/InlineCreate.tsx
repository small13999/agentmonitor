import { useState, type SubmitEvent } from "react";

/** A "+ label" button that opens a one-field form; it posts and reports the gateway's error inline. */
export function InlineCreate({ label, placeholder, submit }: { label: string; placeholder: string; submit: (value: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="ghost" onClick={() => setOpen(true)}>+ {label}</button>;
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("value")).trim();
    if (value === "") return;
    setBusy(true);
    setError(null);
    submit(value).then(
      () => { setBusy(false); setOpen(false); },
      (cause: Error) => { setBusy(false); setError(cause.message); },
    );
  };
  return (
    <form className="inline-create" onSubmit={onSubmit}>
      <input name="value" autoFocus placeholder={placeholder} aria-label={label} disabled={busy} />
      <button type="submit" disabled={busy}>{busy ? "…" : "Add"}</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

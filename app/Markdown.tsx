import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown as the app shows it everywhere (comments, folder files, statuses): GitHub flavour, no raw HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown as the app shows it everywhere (comments, folder files, statuses, the chat): GitHub
 * flavour, no raw HTML. `resolveUrl` maps an image's or a link's URL first, e.g. a path in a
 * session's workspace to the URL that serves it (CHAT-5); null leaves it to the usual cleaning.
 * Mapped links open in a new tab, so the app stays where it is.
 */
export function Markdown({ text, resolveUrl }: { text: string; resolveUrl?: (url: string, kind: "image" | "link") => string | null }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => resolveUrl?.(url, key === "src" ? "image" : "link") ?? defaultUrlTransform(url)}
        components={resolveUrl === undefined ? undefined : { a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(value: string): string {
  try {
    const url = new URL(value, "https://example.invalid");
    return url.protocol === "http:" || url.protocol === "https:" ? value : "";
  } catch { return ""; }
}
export function renderMarkdown(text: string, options?: { caret?: boolean }): ReactNode {
  return <div className="rb-chat-md"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={{
    a: ({href,children}) => href ? <a href={href} target="_blank" rel="noreferrer noopener" className="rb-chat-md-link">{children}</a> : <span>{children}</span>,
    table: ({children}) => <div className="rb-chat-table-scroll" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
    code: ({children,className}) => <code className={className ?? "rb-chat-inline-code"}>{children}</code>,
    img: ({alt}) => <span>{alt}</span>,
  }}>{text}</Markdown>{options?.caret && <span className="rb-chat-caret" aria-hidden="true" />}</div>;
}

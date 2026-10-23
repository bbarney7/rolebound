import type { ToolCardDetails } from "../../../shared/types";

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function canRenderRunProgressCard(details: ToolCardDetails): boolean {
  return typeof details.path === "string";
}

export default function RunProgressCard({ details }: { details: ToolCardDetails }) {
  if (typeof details.path !== "string") return null;
  const file = basename(details.path);
  const text = typeof details.text === "string" ? details.text : null;
  const setDefault = details.setDefault === true;

  return (
    <section className="rb-chat-card rb-chat-card--progress">
      <span className="rb-chat-file-chip">{file}</span>
      {text !== null ? (
        <p className="rb-chat-card-line">
          Read {wordCount(text)} words from {file}
        </p>
      ) : null}
      {setDefault ? <p className="rb-chat-card-line">Set as your default resume</p> : null}
    </section>
  );
}

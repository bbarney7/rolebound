import type { ToolCardDetails } from "../../../shared/types";
import { renderMarkdown } from "../markdown";

function readSectionNames(details: ToolCardDetails): string[] {
  if (!Array.isArray(details.sections)) return [];
  const names: string[] = [];
  for (const item of details.sections) {
    if (typeof item === "string") names.push(item);
    else if (item !== null && typeof item === "object" && typeof (item as { section?: unknown }).section === "string") {
      names.push((item as { section: string }).section);
    }
  }
  return names;
}

export function canRenderProfileDiffCard(details: ToolCardDetails): boolean {
  if (typeof details.section === "string" && typeof details.after === "string") return true;
  return readSectionNames(details).length > 0;
}

export default function ProfileDiffCard({ details }: { details: ToolCardDetails }) {
  if (typeof details.section === "string" && typeof details.after === "string") {
    const before = typeof details.before === "string" ? details.before : null;
    return (
      <section className="rb-chat-card rb-chat-card--profile">
        <h3 className="rb-chat-card-heading">Updated your profile: {details.section}</h3>
        <p className="rb-hint">Changes to {details.section} are saved in your profile.</p>
        <details className="rb-chat-disclosure"><summary>View changes</summary>
        <div className="rb-chat-card-body">{renderMarkdown(details.after)}</div>
        {before ? (
          <details className="rb-chat-disclosure">
            <summary>Show previous</summary>
            <div className="rb-chat-card-body rb-chat-card-body--muted">{renderMarkdown(before)}</div>
          </details>
        ) : null}
        </details>
      </section>
    );
  }

  const sections = readSectionNames(details);
  if (sections.length > 0) {
    return (
      <section className="rb-chat-card rb-chat-card--profile">
        <h3 className="rb-chat-card-heading">Read your profile</h3>
        <div className="rb-chat-chip-row">
          {sections.map((s) => (
            <span key={s} className="rb-chat-section-chip">{s}</span>
          ))}
        </div>
      </section>
    );
  }

  return null;
}


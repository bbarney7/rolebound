import type { ToolCardDetails } from "../../../shared/types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function canRenderApplicationCard(details: ToolCardDetails): boolean {
  return str(details.company) !== null || str(details.title) !== null || str(details.applyState) !== null || str(details.status) !== null;
}

function statusPill(state: string | null): { label: string; className: string } {
  if (state === "submitted") return { label: "Sent", className: "rb-chat-pill rb-chat-pill--sent" };
  if (state === "paused_for_user" || state === "blocked") {
    return { label: "Needs you", className: "rb-chat-pill rb-chat-pill--needs" };
  }
  if (state) return { label: state.replace(/_/g, " "), className: "rb-chat-pill" };
  return { label: "In progress", className: "rb-chat-pill" };
}

export default function ApplicationCard({ details }: { details: ToolCardDetails }) {
  const company = str(details.company);
  const title = str(details.title);
  const slug = str(details.slug);
  const state = str(details.applyState) ?? str(details.status);
  if (!company && !title && !state) return null;
  const pill = statusPill(state);

  return (
    <section className="rb-chat-card rb-chat-card--application">
      {company ? <div className="rb-chat-app-company">{company}</div> : null}
      {title ? <div className="rb-chat-app-title">{title}</div> : null}
      <div className="rb-chat-app-footer">
        <span className={pill.className}>{pill.label}</span>
        {slug ? <span className="rb-chat-app-slug">{slug}</span> : null}
      </div>
    </section>
  );
}

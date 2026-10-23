import type { ToolCardDetails } from "../../../shared/types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function canRenderConnectionCard(details: ToolCardDetails): boolean {
  return (
    str(details.provider) !== null ||
    str(details.label) !== null ||
    str(details.status) !== null ||
    str(details.message) !== null
  );
}

export default function ConnectionCard({ details }: { details: ToolCardDetails }) {
  const provider = str(details.provider) ?? str(details.label);
  const status = str(details.status) ?? str(details.message);
  if (!provider && !status) return null;

  return (
    <section className="rb-chat-card rb-chat-card--connection">
      {provider ? <div className="rb-chat-conn-provider">{provider}</div> : null}
      {status ? <div className="rb-chat-conn-status">{status}</div> : null}
    </section>
  );
}

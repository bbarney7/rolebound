import type { RunEntry } from "../../useRun";

export function toolActivityLabel(entry: Extract<RunEntry, { kind: "tool" }>): string {
  const { name, summary } = entry;
  switch (name) {
    case "profile_read":
      return "Read your profile";
    case "profile_update_section":
      return "Updated your profile";
    case "queue_add_url":
      return "Added a job to your queue";
    case "resume_add":
      return "Saved your resume";
    case "resume_extract_text":
      return "Read your resume";
    case "update_application_state":
      return "Updated the application";
    default:
      if (name.startsWith("browser_")) return "Working in the browser";
      return summary || name;
  }
}

export default function ActivityRow({
  entry,
  compact,
}: {
  entry: Extract<RunEntry, { kind: "tool" }>;
  compact?: boolean;
}) {
  const pending = entry.result === null;
  const label = toolActivityLabel(entry);
  return (
    <div className={compact ? "rb-chat-activity rb-chat-activity--compact" : "rb-chat-activity"}>
      {pending ? <span className="rb-chat-activity-dot" aria-hidden="true" /> : null}
      <span className="rb-chat-activity-label">{label}</span>
      {entry.isError && entry.result ? (
        <span className="rb-chat-activity-error" role="alert">{entry.result}</span>
      ) : null}
    </div>
  );
}

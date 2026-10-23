import type { ToolCardDetails } from "../../../shared/types";

function asJob(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export function canRenderJobListCard(details: ToolCardDetails): boolean {
  return Array.isArray(details.jobs);
}

export default function JobListCard({
  details,
  onSend,
}: {
  details: ToolCardDetails;
  onSend: (message: string) => void;
}) {
  if (!Array.isArray(details.jobs)) return null;
  const jobs = details.jobs.map(asJob).filter(Boolean) as Record<string, unknown>[];
  const warning = typeof details.warning === "string" ? details.warning : null;

  return (
    <section className="rb-chat-card rb-chat-card--jobs">
      {warning ? <p className="rb-chat-card-warning">{warning}</p> : null}
      <ul className="rb-chat-job-list">
        {jobs.map((job, i) => {
          const company = str(job.company) ?? "Company";
          const title = str(job.title) ?? "Role";
          const location = str(job.location);
          const url = str(job.url);
          const score = typeof job.score === "number" ? job.score : null;
          return (
            <li key={str(job.slug) ?? `job-${i}`} className="rb-chat-job-row">
              <div className="rb-chat-job-main">
                <div className="rb-chat-job-title">{title}</div>
                <div className="rb-chat-job-meta">
                  <strong>{company}</strong>
                  {location ? <span>, {location}</span> : null}
                </div>
                {url || score !== null ? (
                  <div className="rb-chat-job-extras">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" className="rb-chat-job-link">
                        View posting
                      </a>
                    ) : null}
                    {/* Scores arrive as 0-100 fit percentages or as 1-5 ratings. */}
                    {score !== null ? (
                      <span className="rb-chat-job-score">{score > 5 ? `${Math.round(score)}% fit` : `Fit ${score}/5`}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="rb-chat-btn rb-chat-btn--apply"
                onClick={() => onSend(`Apply to ${company}, ${title}`)}
              >
                Apply
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

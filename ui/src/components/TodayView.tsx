import type { Application, Overview, QueueItem, ReadinessPayload, RunSummary } from "../../shared/types";

function relativeDays(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export default function TodayView({
  overview,
  queue,
  applications,
  readiness,
  run,
  runActive,
  onRun,
  onApplyNext,
  onGather,
  onNavigate,
  onOpenApplication,
}: {
  overview: Overview;
  queue: QueueItem[];
  applications: Application[];
  readiness: ReadinessPayload | null;
  run: RunSummary | null;
  runActive: boolean;
  onRun: () => void;
  onApplyNext: () => void;
  onGather: () => void;
  onNavigate: (href: string) => void;
  onOpenApplication: (slug: string, filter?: { apply?: string; status?: string }) => void;
}) {
  const blockers = readiness?.steps.flatMap((step) => step.blockers) ?? [];
  const uniqueBlockers = [...new Map(blockers.map((b) => [b.code, b])).values()];
  const attention = applications.filter((a) => a.applyState === "paused_for_user" || a.applyState === "blocked");
  const visibleAttention = attention.slice(0, 5);
  const recent = [...applications]
    .sort((a, b) => (b.lastUpdated ?? b.submittedAt ?? "").localeCompare(a.lastUpdated ?? a.submittedAt ?? ""))
    .slice(0, 5);
  const next = queue[0] ?? null;
  const applyReady = Boolean(readiness?.applyReady);
  const canApply = applyReady && !runActive && Boolean(next);

  const actionHead = runActive
    ? "Supervise the active agent session"
    : !applyReady
      ? "Finish setup to unlock applying"
      : !next
        ? "Find roles worth adding to your shortlist"
        : `Apply next: ${next.title ?? next.slug}`;

  const actionLead = runActive
    ? `${run?.sessionName ?? "A session"} is running — respond there before starting another apply.`
    : !applyReady
      ? uniqueBlockers[0]?.message ?? "Complete the remaining setup steps first."
      : next
        ? `${next.company ?? "Company unavailable"} · ${next.location ?? "Location unspecified"}`
        : "Find jobs at the companies you watch, add the best fits to your shortlist, then supervise each application.";

  const primaryAction = runActive
    ? { label: "Open session", onClick: onRun, disabled: false }
    : !applyReady
      ? { label: "Open setup", onClick: () => onNavigate("/setup"), disabled: false }
      : !next
        ? { label: "Browse found jobs", onClick: () => onNavigate("/discover"), disabled: false }
        : { label: "Apply next in queue", onClick: onApplyNext, disabled: !canApply };

  const gatherMeta = overview.lastFullGather
    ? `Last searched ${relativeDays(overview.lastFullGather)} · ${overview.lastFullGather.slice(0, 10)}`
    : "Not searched yet";

  return (
    <article className="rb-today">
      <header className="rb-today-page">
        <h1 className="rb-display-title">Today</h1>
        <p className="rb-today-meta">{gatherMeta}</p>
      </header>

      <section className="rb-today-editorial" aria-label="Next action">
        <h2 className="rb-action-head">{actionHead}</h2>
        <p className="rb-action-lead">{actionLead}</p>
        <div className="rb-action-row">
          <button
            type="button"
            className="btn primary rb-cta"
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
          >
            {primaryAction.label}
          </button>
          {!runActive && applyReady ? (
            <button type="button" className="btn ghost" onClick={onGather}>
              Find jobs now
            </button>
          ) : null}
        </div>
      </section>

      {uniqueBlockers.length > 0 ? (
        <ul className="rb-rule-list rb-blocker-list" aria-label="Setup blockers">
          {uniqueBlockers.map((b) => (
            <li className="rb-rule-row" key={b.code}>
              <div>
                <strong>{b.code.replaceAll("_", " ").toLowerCase()}</strong>
                <span>{b.message}</span>
              </div>
              <button type="button" className="text-link" onClick={() => onNavigate(b.href)}>Fix</button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="rb-today-layout">
        <div className="rb-today-main">
          <section className="rb-feed" aria-labelledby="attention-heading">
            <div className="rb-feed-head">
              <h2 id="attention-heading" className="rb-feed-title">Needs your input</h2>
              {attention.length > 0 ? (
                <button type="button" className="text-link" onClick={() => onOpenApplication("")}>
                  All {attention.length}
                </button>
              ) : null}
            </div>
            {attention.length ? (
              <ul className="rb-rule-list">
                {visibleAttention.map((a) => (
                  <li className="rb-rule-row" key={a.slug}>
                    <div>
                      <strong>{a.title ?? a.slug}</strong>
                      <span>
                        {a.company ?? "Company unavailable"} · {a.blockReason ?? "Waiting for your input."}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => (a.applyState === "paused_for_user" ? onRun() : onOpenApplication(a.slug))}
                    >
                      {a.applyState === "paused_for_user" ? "Open session" : "Review"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rb-inline-empty">Nothing paused or blocked right now.</p>
            )}
          </section>

          <section className="rb-feed" aria-labelledby="recent-heading">
            <div className="rb-feed-head">
              <h2 id="recent-heading" className="rb-feed-title">Recent outcomes</h2>
              {applications.length > 0 ? (
                <button type="button" className="text-link" onClick={() => onOpenApplication("")}>
                  All sent
                </button>
              ) : null}
            </div>
            {applications.length ? (
              <ul className="rb-rule-list">
                {recent.map((a) => (
                  <li className="rb-rule-row" key={a.slug}>
                    <button type="button" className="rb-row-link" onClick={() => onOpenApplication(a.slug)}>
                      <strong>{a.title ?? a.slug}</strong>
                      <span>
                        {a.company ?? "Company unavailable"} · {a.estimated ? "Estimated" : a.applyState}
                      </span>
                    </button>
                    <span className="rb-row-tag">{a.pipelineStatus ?? "unset"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rb-inline-empty">No applications yet — add a found job to your shortlist first.</p>
            )}
          </section>
        </div>

        <aside className="rb-today-aside" aria-label="Pipeline">
          <h2 className="rb-aside-title">Pipeline</h2>
          <ul className="rb-pipeline-stats">
            <li>
              <button type="button" className="rb-stat-link" onClick={() => onNavigate("/discover")}>
                <span className="rb-stat-num">{overview.discovered}</span>
                <span className="rb-stat-label">Found</span>
              </button>
            </li>
            <li>
              <button type="button" className="rb-stat-link" onClick={() => onNavigate("/queue")}>
                <span className="rb-stat-num">{overview.queue}</span>
                <span className="rb-stat-label">Shortlist</span>
              </button>
            </li>
            <li>
              <button type="button" className="rb-stat-link" onClick={() => onOpenApplication("")}>
                <span className="rb-stat-num">{overview.applications?.total ?? 0}</span>
                <span className="rb-stat-label">Sent</span>
              </button>
            </li>
          </ul>
          <p className="rb-aside-note">
            {overview.queue > 0
              ? `${overview.queue} role${overview.queue === 1 ? "" : "s"} on your shortlist.`
              : "Your shortlist is empty."}
          </p>
          <button type="button" className="text-link" onClick={() => onNavigate("/queue")}>
            Open shortlist →
          </button>
        </aside>
      </div>
    </article>
  );
}

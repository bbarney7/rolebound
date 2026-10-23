import type { Overview, ReadinessPayload, SetupStep } from "../../shared/types";
import "./rail.css";

type RouteStop = {
  id: "found" | "shortlisted" | "applying" | "waiting" | "attention" | "sent";
  label: string;
  count: number;
  filledClass: string;
};

const CHECKLIST_STEPS: Array<{
  stepId: "connection" | "profile" | "resume" | "targets";
  label: string;
  href: string;
  idleLabel: string;
}> = [
  { stepId: "connection", label: "AI model", href: "/settings", idleLabel: "Not connected" },
  { stepId: "profile", label: "Profile", href: "/profile?tab=identity", idleLabel: "Not started" },
  { stepId: "resume", label: "Resume", href: "/profile?tab=resumes", idleLabel: "None yet" },
  { stepId: "targets", label: "Companies to watch", href: "/discover", idleLabel: "None yet" },
];

/** Counts follow the exact concrete execution states used by application filters. */
export function searchRouteCounts(overview: Overview | null): Record<RouteStop["id"], number> {
  const byApply = overview?.applications?.byApplyState ?? {};
  return {
    found: overview?.discovered ?? 0,
    shortlisted: overview?.queue ?? 0,
    applying: byApply.in_progress ?? 0,
    waiting: byApply.queued ?? 0,
    attention: (byApply.paused_for_user ?? 0) + (byApply.blocked ?? 0),
    sent: byApply.submitted ?? 0,
  };
}

/**
 * A short status word, never the blocker sentence: the rail is a glance, and
 * the full explanation is one click away in the Workspace section the row opens
 * (it stays available as the row's tooltip).
 */
function stepStatus(
  step: SetupStep | undefined,
  idleLabel: string,
  stepId: string,
): { text: string; tone: "ready" | "muted" | "warn"; hint?: string } {
  if (step?.complete) return { text: "Ready", tone: "ready" };
  if (!step) return { text: "Checking…", tone: "muted" };
  if (stepId === "profile" && !step.blockers.some(b => b.code === "PROFILE_MISSING")) return { text: "Needs details", tone: "warn", hint: step.blockers[0]?.message };
  return { text: idleLabel, tone: stepId === "connection" ? "warn" : "muted", hint: step?.blockers[0]?.message };
}

export default function SearchRail({
  overview,
  readiness,
  onNavigate,
}: {
  overview: Overview | null;
  readiness: ReadinessPayload | null;
  onNavigate: (href: string) => void;
}) {
  const counts = searchRouteCounts(overview);
  const stops: RouteStop[] = [
    { id: "found", label: "Found", count: counts.found, filledClass: "rb-route-dot--accent" },
    { id: "shortlisted", label: "Shortlisted", count: counts.shortlisted, filledClass: "rb-route-dot--accent" },
    { id: "applying", label: "Applying", count: counts.applying, filledClass: "rb-route-dot--needs" },
    ...(counts.waiting ? [{ id: "waiting" as const, label: "Waiting", count: counts.waiting, filledClass: "rb-route-dot--needs" }] : []),
    { id: "attention", label: "Needs you", count: counts.attention, filledClass: "rb-route-dot--needs" },
    { id: "sent", label: "Sent", count: counts.sent, filledClass: "rb-route-dot--sent" },
  ];
  const destinations = {found:"/discover",shortlisted:"/queue",applying:"/applications?apply=active",waiting:"/applications?apply=waiting",attention:"/applications?apply=attention",sent:"/applications?apply=submitted"};
  const allZero = stops.every((stop) => stop.count === 0);

  const stepsById = new Map(readiness?.steps.map((step) => [step.id, step]) ?? []);
  const checklistReady = CHECKLIST_STEPS.every((row) => stepsById.get(row.stepId)?.complete);

  return (
    <div className="rb-search-rail">
      <section className="rb-search-route" aria-labelledby="rb-search-route-heading">
        <h2 id="rb-search-route-heading" className="rb-search-rail-title">Your search</h2>
        <ol className="rb-route-stops">
          <li className="rb-route-track" aria-hidden="true" />
          {stops.map((stop) => (
            <li className="rb-route-stop" key={stop.id}>
              <span
                className={`rb-route-dot${stop.count > 0 ? ` ${stop.filledClass}` : ""}`}
                aria-hidden="true"
              />
              <button className="rb-route-link" type="button" onClick={() => onNavigate(destinations[stop.id])}><span className="rb-route-label">{stop.label}</span><span className={`rb-route-count${stop.count === 0 ? " rb-route-count--zero" : ""}`}>{stop.count}</span></button>
            </li>
          ))}
        </ol>
        {allZero ? (
          <p className="rb-route-empty">
            {!readiness ? "Checking your workspace…" : readiness.discoverReady ? "Ready to find your first role. Explore jobs or choose companies to watch." : readiness.steps.find(s => !s.complete && s.id !== "readiness")?.blockers[0]?.message ?? "Finish setup to start your search."}
            <button className="small-link" type="button" onClick={() => onNavigate(readiness?.discoverReady ? "/discover" : "/setup")}>{readiness?.discoverReady ? "Find jobs" : "Review setup"}</button>
          </p>
        ) : null}
      </section>

      {!checklistReady ? (
        <section className="rb-search-checklist" aria-labelledby="rb-search-checklist-heading">
          <h3 id="rb-search-checklist-heading" className="rb-search-checklist-title">Before the first application</h3>
          <ul className="rb-search-checklist-list">
            {CHECKLIST_STEPS.map((row) => {
              const status = stepStatus(stepsById.get(row.stepId), row.idleLabel, row.stepId);
              return (
                <li key={row.stepId}>
                  <button
                    type="button"
                    className="rb-search-checklist-row"
                    title={status.hint}
                    onClick={() => onNavigate(stepsById.get(row.stepId)?.blockers[0]?.href ?? row.href)}
                  >
                    <span>{row.label}</span>
                    <span className={`rb-search-checklist-status rb-search-checklist-status--${status.tone}`}>
                      {status.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

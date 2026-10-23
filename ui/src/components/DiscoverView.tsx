import { useWorkspaceState, useUnsavedChanges } from "../WorkspaceDrafts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiscoveryDetailPayload, DiscoveryListItem, TargetEntry, TargetSource, TargetsPayload } from "../../shared/discovery";
import type { ReadinessBlocker } from "../../shared/types";
import { TARGET_SOURCES } from "../../shared/discovery";
import {
  dismissDiscovery,
  fetchDiscoveries,
  fetchDiscoveryDetail,
  fetchTargets,
  promoteQueueItem,
  restoreDiscovery,
  updateTargets,
} from "../api";
import { startRun } from "../runs";

function scoreLabel(score: number | null): string {
  if (score == null) return "Unscored";
  if (score >= 5) return "Strong fit";
  if (score === 4) return "Good fit";
  if (score === 3) return "Fair fit";
  return "Weak fit";
}

function formatDiscoverDate(iso: string | null): string {
  if (!iso) return "Unknown date";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function DiscoverView({
  runActive,
  onPromoted,
  onNavigate,
  discoverReady = true,
  scoreReady = true,
  tab = "",
  discoverBlocker = null,
  scoreBlocker = null,
}: {
  runActive: boolean;
  onPromoted: () => void;
  onNavigate?: (href: string) => void;
  discoverReady?: boolean;
  scoreReady?: boolean;
  tab?: string;
  discoverBlocker?: ReadinessBlocker | null;
  scoreBlocker?: ReadinessBlocker | null;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DiscoveryListItem[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<DiscoveryDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [targetsSaved,setTargetsSaved] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [targetDraft, setTargetDraft] = useWorkspaceState("company-targets", { value: "", baseline: "", revision: null as string | null, loaded: false });
  const draftTargets = targetDraft.value;
  const targetDirty = draftTargets !== targetDraft.baseline;
  useUnsavedChanges("company-targets",targetDirty);
  const setDraftTargets = (value: string) => { setTargetsSaved(false); setTargetDraft(old => ({...old,value})); };
  async function openTargets() {
    setShowTargets(true);
    try {
      const payload = await fetchTargets(); setTargets(payload);
      const value = payload.entries.map(entry => `${entry.source}:${entry.slug}`).join("\n");
      setTargetDraft(old => old.loaded && old.value !== old.baseline ? old : {value,baseline:value,revision:payload.revision,loaded:true});
    } catch(err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  useEffect(() => { if (tab === "companies") void openTargets(); else setShowTargets(false); },[tab]);

  const selectedSlugRef = useRef<string | null>(null);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  useEffect(() => {
    selectedSlugRef.current = selectedSlug;
  }, [selectedSlug]);

  const loadList = async (q = query) => {
    const requestId = ++listRequestRef.current;
    try {
      const list = await fetchDiscoveries({ q, dismissed: "false", limit: 100 });
      if (listRequestRef.current !== requestId) return;
      setError(null);
      let nextItems = list.items;
      const current = selectedSlugRef.current;
      if (current && !nextItems.some((item) => item.slug === current)) {
        try {
          const pinned = await fetchDiscoveryDetail(current);
          if (pinned?.dismissed) {
            nextItems = [pinned, ...nextItems];
          } else {
            setSelectedSlug(nextItems[0]?.slug ?? null);
          }
        } catch {
          setSelectedSlug(nextItems[0]?.slug ?? null);
        }
      } else if (!current && nextItems[0]) {
        setSelectedSlug(nextItems[0].slug);
      }
      setItems(nextItems);
    } catch (err) {
      if (listRequestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshDetail = async (slug: string) => {
    const requestId = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError(null);
    setDetail((prev) => (prev?.slug === slug ? prev : null));
    try {
      const payload = await fetchDiscoveryDetail(slug);
      if (detailRequestRef.current !== requestId) return;
      if (selectedSlugRef.current !== slug) return;
      if (payload.slug !== slug) return;
      setDetail(payload);
      setDetailError(null);
    } catch (err) {
      if (detailRequestRef.current !== requestId) return;
      if (selectedSlugRef.current !== slug) return;
      setDetail(null);
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      if (detailRequestRef.current === requestId && selectedSlugRef.current === slug) {
        setDetailLoading(false);
      }
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadList(query);
    }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      listRequestRef.current += 1;
    };
  }, [query]);

  useEffect(() => {
    if (!selectedSlug) {
      detailRequestRef.current += 1;
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    void refreshDetail(selectedSlug);
    return () => {
      detailRequestRef.current += 1;
    };
  }, [selectedSlug]);

  const selectedIndex = useMemo(
    () => (selectedSlug ? items.findIndex((item) => item.slug === selectedSlug) : -1),
    [items, selectedSlug],
  );

  const detailReady = Boolean(selectedSlug && detail?.slug === selectedSlug && !detailLoading && !detailError);
  const mutationSlug = detailReady ? detail!.slug : null;

  async function runAction(label: string, action: () => Promise<unknown>, actionSlug: string | null = null) {
    setBusy(label);
    setError(null);
    const slugAtStart = actionSlug ?? mutationSlug ?? selectedSlugRef.current;
    try {
      await action();
      await loadList();
      if (slugAtStart && (label === "dismiss" || label === "restore")) {
        setSelectedSlug(slugAtStart);
        await refreshDetail(slugAtStart);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const goQueue = () => {
    if (onNavigate) onNavigate("/queue");
    else window.history.pushState({}, "", "/queue");
  };

  return (
    <div className="discover-layout rb-discover">
      <header className="rb-discover-head">
        <h1 className="rb-display-title">Opportunities</h1>
        <p className="rb-discover-lead">Triage gathered roles, score fit, and promote into preparation.</p>
      </header>

      <div className="rb-workbench-toolbar">
        <input
          aria-label="Filter opportunities"
          placeholder="Filter by role, company, or location"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="control rb-filter"
        />
        <div className="rb-toolbar-actions">
          <button
            type="button"
            className="btn"
            disabled={runActive || !!busy || !discoverReady}
            onClick={() => void runAction("gather", () => startRun({ kind: "gather" }))}
          >
            Gather now
          </button>
          {!discoverReady && discoverBlocker ? (
            <p className="rb-inline-hint">
              {discoverBlocker.message}
              {onNavigate ? (
                <button type="button" className="small-link" onClick={() => onNavigate(discoverBlocker.href)}>
                  Fix this
                </button>
              ) : null}
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={runActive || !!busy || !scoreReady}
            onClick={() => void runAction("score", () => startRun({ kind: "score" }))}
          >
            Score unscored
          </button>
          {!scoreReady && scoreBlocker ? (
            <p className="rb-inline-hint">
              {scoreBlocker.message}
              {onNavigate ? (
                <button type="button" className="small-link" onClick={() => onNavigate(scoreBlocker.href)}>
                  Fix this
                </button>
              ) : null}
            </p>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            onClick={() => void openTargets()}
          >
            Edit targets
          </button>
        </div>
      </div>

      {error ? <div className="rb-inline-error" role="alert">{error}</div> : null}
      {targetsSaved && <p className="rb-form-status" role="status">Companies saved.</p>}

      {showTargets && targets ? (
        <section className="rb-company-settings" aria-label="Companies to watch">
          <form onSubmit={(event) => event.preventDefault()}>
            <h3>Companies to watch</h3>
            <p className="rb-hint">One source:slug per line, for example greenhouse:acme. Supported sources: greenhouse, ashby, lever.</p>
            <textarea aria-label="Targets" value={draftTargets} onChange={(event) => setDraftTargets(event.target.value)} rows={8} />
            <p className="rb-hint" role="status">{targetDirty ? "Unsaved changes" : "Up to date"}</p>
            <div className="dialog-actions">
              <button type="button" className="btn ghost" onClick={() => setShowTargets(false)}>Cancel</button>
              <button
                type="button"
                className="btn primary"
                disabled={!!busy || !targetDirty}
                onClick={() => void runAction("targets", async () => {
                  const entries: TargetEntry[] = draftTargets
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const colon = line.indexOf(":");
                      if (colon < 0) throw new Error(`invalid target line: ${line}`);
                      const source = line.slice(0, colon).trim();
                      const slug = line.slice(colon + 1).trim();
                      if (!TARGET_SOURCES.includes(source as TargetSource)) {
                        throw new Error(`unsupported target source: ${source}`);
                      }
                      if (!slug) throw new Error(`missing slug in target line: ${line}`);
                      return { source: source as TargetSource, slug };
                    });
                  const saved = await updateTargets({ revision: targetDraft.revision, entries });
                  setTargets(saved);
                  const value = entries.map(entry => `${entry.source}:${entry.slug}`).join("\n");
                  setTargetDraft(old => ({...old,baseline:value,revision:saved.revision}));
                  setTargetsSaved(true); setShowTargets(false);
                })}
              >
                {busy === "targets" ? "Saving…" : "Save companies"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
      <div className="rb-workbench" hidden={showTargets}>
        <div className="rb-workbench-list" role="listbox" aria-label="Opportunities">
          {items.length === 0 ? (
            <p className="rb-inline-empty">No opportunities yet — run gather from your targets.</p>
          ) : (
            items.map((item) => (
              <button
                type="button"
                key={item.slug}
                role="option"
                aria-selected={item.slug === selectedSlug}
                className={`rb-opp-row${item.slug === selectedSlug ? " is-selected" : ""}`}
                onClick={() => setSelectedSlug(item.slug)}
              >
                <span className="rb-opp-score">{item.llmScore ?? "–"}</span>
                <span className="rb-opp-copy">
                  <strong>{item.title ?? item.slug}</strong>
                  <span>{item.company ?? "Company unavailable"} · {item.location ?? "Remote"}</span>
                </span>
                <span className="rb-opp-fit">{scoreLabel(item.llmScore)}</span>
              </button>
            ))
          )}
        </div>

        <div className="rb-workbench-detail" aria-busy={detailLoading || undefined}>
          {detailReady && detail ? (
            <>
              <p className="rb-detail-kicker">
                {(detail.source ?? "Unknown").toUpperCase()} · Discovered {formatDiscoverDate(detail.discoveredAt)}
              </p>
              <h2 className="rb-detail-title">{detail.title ?? detail.slug}</h2>
              <p className="rb-detail-meta">{detail.company ?? "Company unavailable"} · {detail.location ?? "Location unspecified"}</p>
              <p className="rb-detail-score">
                {scoreLabel(detail.llmScore)}
                {detail.llmReasoning ? ` — ${detail.llmReasoning}` : ""}
              </p>
              {detail.duplicateOf ? <p className="note">Already in {detail.duplicateOf}.</p> : null}
              {busy ? <p className="note" aria-live="polite">Working… ({busy})</p> : null}
              <div className="rb-detail-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!mutationSlug || !!busy || runActive || !!detail.duplicateOf || detail.dismissed}
                  onClick={() => mutationSlug && void runAction("promote", async () => { await promoteQueueItem({ slug: mutationSlug }); onPromoted(); }, mutationSlug)}
                >
                  Promote to queue
                </button>
                {!detail.dismissed ? (
                  <button type="button" className="btn ghost" disabled={!mutationSlug || !!busy} onClick={() => mutationSlug && void runAction("dismiss", () => dismissDiscovery(mutationSlug), mutationSlug)}>
                    Dismiss
                  </button>
                ) : (
                  <button type="button" className="btn ghost" disabled={!mutationSlug || !!busy} onClick={() => mutationSlug && void runAction("restore", () => restoreDiscovery(mutationSlug), mutationSlug)}>
                    Restore
                  </button>
                )}
                <button type="button" className="btn ghost" disabled={selectedIndex <= 0} onClick={() => setSelectedSlug(items[selectedIndex - 1]?.slug ?? null)}>
                  Previous
                </button>
                <button type="button" className="btn ghost" disabled={selectedIndex < 0 || selectedIndex >= items.length - 1} onClick={() => setSelectedSlug(items[selectedIndex + 1]?.slug ?? null)}>
                  Next
                </button>
                <button type="button" className="text-link" onClick={goQueue}>
                  Preparation →
                </button>
              </div>
              <pre className="rb-detail-body">{detail.descriptionExcerpt ?? detail.body}</pre>
            </>
          ) : detailError && selectedSlug ? (
            <div className="rb-detail-error">
              <p className="rb-inline-error" role="alert">{detailError}</p>
              <button type="button" className="btn" onClick={() => void refreshDetail(selectedSlug)}>
                Retry
              </button>
            </div>
          ) : selectedSlug ? (
            <p className="rb-inline-empty" aria-live="polite">Loading opportunity…</p>
          ) : (
            <p className="rb-inline-empty">Select an opportunity to review details and promote.</p>
          )}
        </div>
      </div>


    </div>
  );
}

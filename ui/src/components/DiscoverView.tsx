import { useWorkspaceState, useUnsavedChanges } from "../WorkspaceDrafts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DiscoveryDetailPayload, DiscoveryListItem, TargetEntry, TargetsPayload } from "../../shared/discovery";
import type { ReadinessBlocker } from "../../shared/types";
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
import {
  entriesToTargetText,
  parseCompanyTargetInput,
  parseTargetTextToEntries,
  sourceLabel,
} from "../parseCompanyTarget";
import "../jobSearch.css";

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

function listEntriesFromDraft(draft: string): TargetEntry[] {
  try {
    return parseTargetTextToEntries(draft);
  } catch {
    return [];
  }
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
  const isCompaniesTab = tab === "companies";
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DiscoveryListItem[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<DiscoveryDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TargetsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [targetsSaved, setTargetsSaved] = useState(false);
  const [addCompanyInput, setAddCompanyInput] = useState("");
  const [addCompanyError, setAddCompanyError] = useState<string | null>(null);
  const [targetDraft, setTargetDraft] = useWorkspaceState("company-targets", { value: "", baseline: "", revision: null as string | null, loaded: false });
  const draftTargets = targetDraft.value;
  const targetDirty = draftTargets !== targetDraft.baseline;
  useUnsavedChanges("company-targets", targetDirty);
  const setDraftTargets = (value: string) => {
    setTargetsSaved(false);
    setTargetDraft((old) => ({ ...old, value }));
  };
  const listedCompanies = useMemo(() => listEntriesFromDraft(draftTargets), [draftTargets]);

  async function loadTargets() {
    try {
      const payload = await fetchTargets();
      setTargets(payload);
      const value = entriesToTargetText(payload.entries);
      setTargetDraft((old) =>
        old.loaded && old.value !== old.baseline ? old : { value, baseline: value, revision: payload.revision, loaded: true },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (isCompaniesTab) void loadTargets();
  }, [isCompaniesTab]);

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
    if (isCompaniesTab) return;
    const timer = window.setTimeout(() => {
      void loadList(query);
    }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      listRequestRef.current += 1;
    };
  }, [query, isCompaniesTab]);

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
      if (!isCompaniesTab) await loadList();
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

  const goCompanies = () => {
    if (onNavigate) onNavigate("/discover?tab=companies");
    else window.history.pushState({}, "", "/discover?tab=companies");
  };

  function removeCompany(entry: TargetEntry) {
    const next = listedCompanies.filter((row) => row.source !== entry.source || row.slug !== entry.slug);
    setDraftTargets(entriesToTargetText(next));
  }

  function addCompany() {
    const parsed = parseCompanyTargetInput(addCompanyInput);
    if (!parsed.ok) {
      setAddCompanyError(parsed.error);
      return;
    }
    if (listedCompanies.some((row) => row.source === parsed.entry.source && row.slug === parsed.entry.slug)) {
      setAddCompanyError(null);
      setAddCompanyInput("");
      return;
    }
    const next = [...listedCompanies, parsed.entry];
    setDraftTargets(entriesToTargetText(next));
    setAddCompanyInput("");
    setAddCompanyError(null);
  }

  const sessionHint = <p className="rb-inline-hint">Finish or end the chat session to use this.</p>;

  if (isCompaniesTab) {
    return (
      <div className="discover-layout rb-discover">
        <header className="rb-discover-head">
          <h1 className="rb-display-title">Companies to watch</h1>
          <p className="rb-discover-lead">Rolebound searches these company job boards when you find new jobs.</p>
        </header>

        {error ? <div className="rb-inline-error" role="alert">{error}</div> : null}
        {targetsSaved && <p className="rb-form-status" role="status">Companies saved.</p>}

        {targets ? (
          <section className="rb-company-settings" aria-label="Companies to watch">
            <form onSubmit={(event) => event.preventDefault()}>
              {listedCompanies.length === 0 ? (
                <p className="rb-inline-empty">No companies yet. Add one below.</p>
              ) : (
                <ul className="rb-company-target-list">
                  {listedCompanies.map((entry) => (
                    <li key={`${entry.source}:${entry.slug}`} className="rb-company-target-row">
                      <div>
                        <span className="rb-company-target-name">{entry.slug}</span>
                        <span className="rb-company-target-source">{sourceLabel(entry.source)}</span>
                      </div>
                      <button type="button" className="btn ghost" onClick={() => removeCompany(entry)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="rb-company-add">
                <label htmlFor="add-company">Add a company</label>
                <input
                  id="add-company"
                  className="control"
                  value={addCompanyInput}
                  placeholder="Careers board link or greenhouse:acme"
                  onChange={(event) => {
                    setAddCompanyInput(event.target.value);
                    setAddCompanyError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCompany();
                    }
                  }}
                />
                {addCompanyError ? <p className="rb-inline-error" role="alert">{addCompanyError}</p> : null}
                <button type="button" className="btn" onClick={() => addCompany()}>
                  Add
                </button>
              </div>

              <details className="rb-company-text-edit">
                <summary>Edit as text</summary>
                <textarea aria-label="Companies as text" value={draftTargets} onChange={(event) => setDraftTargets(event.target.value)} rows={8} />
              </details>

              <p className="rb-hint" role="status">{targetDirty ? "Unsaved changes" : "Up to date"}</p>
              <div className="dialog-actions">
                <button type="button" className="btn primary" disabled={!!busy || !targetDirty} onClick={() => void runAction("targets", async () => {
                  const entries = parseTargetTextToEntries(draftTargets);
                  const saved = await updateTargets({ revision: targetDraft.revision, entries });
                  setTargets(saved);
                  const value = entriesToTargetText(entries);
                  setTargetDraft((old) => ({ ...old, baseline: value, revision: saved.revision }));
                  setTargetsSaved(true);
                })}>
                  {busy === "targets" ? "Saving…" : "Save companies"}
                </button>
              </div>
            </form>
          </section>
        ) : (
          <p className="rb-inline-empty">Loading companies…</p>
        )}
      </div>
    );
  }

  return (
    <div className="discover-layout rb-discover">
      <header className="rb-discover-head">
        <h1 className="rb-display-title">Found jobs</h1>
        <p className="rb-discover-lead">Jobs Rolebound found at the companies you watch. Add the good ones to your shortlist.</p>
      </header>

      <div className="rb-workbench-toolbar">
        <input
          aria-label="Filter found jobs"
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
            Find jobs now
          </button>
          {!discoverReady && !runActive && discoverBlocker ? (
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
            Score new jobs
          </button>
          {!scoreReady && !runActive && scoreBlocker ? (
            <p className="rb-inline-hint">
              {scoreBlocker.message}
              {onNavigate ? (
                <button type="button" className="small-link" onClick={() => onNavigate(scoreBlocker.href)}>
                  Fix this
                </button>
              ) : null}
            </p>
          ) : null}
          {runActive ? sessionHint : null}
          <button type="button" className="btn ghost" onClick={goCompanies}>
            Companies to watch
          </button>
        </div>
      </div>

      {error ? <div className="rb-inline-error" role="alert">{error}</div> : null}
      {targetsSaved && <p className="rb-form-status" role="status">Companies saved.</p>}

      <div className="rb-workbench">
        <div className="rb-workbench-list" role="listbox" aria-label="Found jobs">
          {items.length === 0 ? (
            <p className="rb-inline-empty">No found jobs yet — find jobs from the companies you watch.</p>
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
                {(detail.source ?? "Unknown").toUpperCase()} · Found {formatDiscoverDate(detail.discoveredAt)}
              </p>
              <h2 className="rb-detail-title">{detail.title ?? detail.slug}</h2>
              <p className="rb-detail-meta">{detail.company ?? "Company unavailable"} · {detail.location ?? "Location unspecified"}</p>
              <p className="rb-detail-score">
                {scoreLabel(detail.llmScore)}
                {detail.llmReasoning ? ` — ${detail.llmReasoning}` : ""}
              </p>
              {detail.duplicateOf ? <p className="note">Already on your shortlist as {detail.duplicateOf}.</p> : null}
              {busy ? <p className="note" aria-live="polite">Working… ({busy})</p> : null}
              <div className="rb-detail-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!mutationSlug || !!busy || runActive || !!detail.duplicateOf || detail.dismissed}
                  onClick={() => mutationSlug && void runAction("promote", async () => { await promoteQueueItem({ slug: mutationSlug }); onPromoted(); }, mutationSlug)}
                >
                  Add to shortlist
                </button>
                {runActive ? sessionHint : null}
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
                  Shortlist →
                </button>
              </div>
              <div className="rb-detail-prose">{detail.descriptionExcerpt ?? detail.body}</div>
            </>
          ) : detailError && selectedSlug ? (
            <div className="rb-detail-error">
              <p className="rb-inline-error" role="alert">{detailError}</p>
              <button type="button" className="btn" onClick={() => void refreshDetail(selectedSlug)}>
                Retry
              </button>
            </div>
          ) : selectedSlug ? (
            <p className="rb-inline-empty" aria-live="polite">Loading job…</p>
          ) : (
            <p className="rb-inline-empty">Select a job to review details and add it to your shortlist.</p>
          )}
        </div>
      </div>
    </div>
  );
}

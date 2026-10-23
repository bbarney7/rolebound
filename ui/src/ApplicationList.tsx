import { matchesApplicationFilter } from "./applicationFilters";
import { APPLY_STATES, PIPELINE_STATUSES, type Application } from "../shared/types";
import Stamp, { applyStateTone, humanize, pipelineTone } from "./Stamp";
import "./surfaces.css";
import "./jobSearch.css";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

function ApplicationTable({ rows, onSelect }: { rows: Application[]; onSelect: (slug: string) => void }) {
  return (
    <div className="table-scroll rb-record-list">
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Company</th>
            <th>Location</th>
            <th>Execution</th>
            <th>Hiring</th>
            <th className="num">Applied</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.slug} className="row" onClick={() => onSelect(a.slug)}>
              <td data-label="Role" className="rb-stack-skip-label">
                <button
                  type="button"
                  className="row-open rb-record-title"
                  aria-label={`Open ${a.company ?? a.slug} — ${a.title ?? "untitled role"}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(a.slug);
                  }}
                >
                  {a.title ?? "—"}
                </button>
              </td>
              <td data-label="Company">{a.company ?? a.slug}</td>
              <td data-label="Location">{a.location ?? "—"}</td>
              <td data-label="Execution">
                <Stamp tone={applyStateTone(a.applyState)}>{humanize(a.applyState)}</Stamp>
              </td>
              <td data-label="Hiring">
                {a.pipelineStatus ? (
                  <Stamp tone={pipelineTone(a.pipelineStatus)}>{humanize(a.pipelineStatus)}</Stamp>
                ) : (
                  <span className="slug">not set</span>
                )}
              </td>
              <td className="num" data-label="Applied">
                {formatDate(a.submittedAt)}
                {a.estimated && (
                  <span className="est" title="Date is estimated from when the job file was last updated">
                    estimated
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoApplications({ onNavigate }: { onNavigate?: (href: string) => void }) {
  return (
    <div className="rb-empty state">
      <span className="glyph" aria-hidden="true">∅</span>
      <p>No applications yet.</p>
      {onNavigate ? (
        <div className="rb-form-actions">
          <button type="button" className="btn primary" onClick={() => onNavigate("/discover")}>
            Find jobs
          </button>
          <button type="button" className="btn" onClick={() => onNavigate("/queue")}>
            Open shortlist
          </button>
        </div>
      ) : (
        <p>Find jobs and add roles to your shortlist to get started.</p>
      )}
    </div>
  );
}

export function RecentApplications({
  applications,
  onSelect,
  onShowAll,
}: {
  applications: Application[];
  onSelect: (slug: string) => void;
  onShowAll: () => void;
}) {
  return (
    <div className="rb-list-panel card">
      <div className="rb-list-panel-head head">
        <h2 className="rb-h-major">Recent applications</h2>
        <button type="button" className="btn" onClick={onShowAll}>
          All applications →
        </button>
      </div>
      {applications.length === 0 ? <NoApplications /> : <ApplicationTable rows={applications.slice(0, 8)} onSelect={onSelect} />}
    </div>
  );
}

export default function ApplicationList({
  applications,
  search,
  status,
  applyState,
  from,
  to,
  onSearchChange,
  onStatusChange,
  onApplyStateChange,
  onFromChange,
  onToChange,
  onSelect,
  onNavigate,
}: {
  applications: Application[];
  search: string;
  status: string;
  applyState: string;
  from: string;
  to: string;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onApplyStateChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onSelect: (slug: string) => void;
  onNavigate?: (href: string) => void;
}) {
  const needle = search.trim().toLowerCase();
  const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
  const toMs = to ? Date.parse(`${to}T23:59:59.999Z`) : null;

  const visible = applications.filter((a) => {
    if (needle) {
      const haystack = `${a.company ?? ""} ${a.title ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (!matchesApplicationFilter(a.applyState, applyState)) return false;
    if (status === "none") {
      if (a.pipelineStatus !== null) return false;
    } else if (status !== "all") {
      if (a.pipelineStatus !== status) return false;
    }
    if (fromMs !== null || toMs !== null) {
      if (!a.submittedAt) return false;
      const t = Date.parse(a.submittedAt);
      if (Number.isNaN(t)) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
    }
    return true;
  });

  const emptyWorkspace = applications.length === 0;

  return (
    <div className="rb-surface rb-job-search-stack">
      <div className="rb-list-panel card">
        {!emptyWorkspace ? (
          <>
            <div className="rb-filter-bar toolbar">
              <div className="rb-field field">
                <label htmlFor="filter-search">Company or role</label>
                <input
                  id="filter-search"
                  className="control search"
                  type="search"
                  placeholder="search…"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              </div>
              <div className="rb-field field">
                <label htmlFor="filter-apply">Execution state</label>
                <select id="filter-apply" className="control" value={applyState} onChange={(e) => onApplyStateChange(e.target.value)}>
                  <option value="active">Applying now</option><option value="waiting">Waiting to start</option><option value="attention">Needs you</option>
                  <option value="all">all</option>
                  {APPLY_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="rb-field field">
                <label htmlFor="filter-status">Hiring stage</label>
                <select id="filter-status" className="control" value={status} onChange={(e) => onStatusChange(e.target.value)}>
                  <option value="all">all</option>
                  <option value="none">— not set —</option>
                  {PIPELINE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rb-field field">
                <label htmlFor="filter-from">Applied from</label>
                <input
                  id="filter-from"
                  className="control"
                  type="date"
                  value={from}
                  onChange={(e) => onFromChange(e.target.value)}
                />
              </div>
              <div className="rb-field field">
                <label htmlFor="filter-to">Applied to</label>
                <input id="filter-to" className="control" type="date" value={to} onChange={(e) => onToChange(e.target.value)} />
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="rb-section-note note count" style={{ padding: "1rem 1.1rem" }}>No applications match these filters.</p>
            ) : (
              <div className="rb-list-panel-body">
                <ApplicationTable rows={visible} onSelect={onSelect} />
              </div>
            )}
          </>
        ) : (
          <NoApplications onNavigate={onNavigate} />
        )}
      </div>
      {!emptyWorkspace ? (
        <div className="rb-footnotes">
          <p className="note">Dates marked as estimated are when the job was last updated, not a confirmed submission time.</p>
        </div>
      ) : null}
    </div>
  );
}

import type { QueueItem } from "../shared/types";
import Stamp from "./Stamp";
import "./surfaces.css";
import "./jobSearch.css";

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 10);
}

function overrideSummary(item: QueueItem): string {
  const parts: string[] = [];
  if (item.resumeKey) parts.push(`resume_key: ${item.resumeKey}`);
  if (item.addressCityKey) parts.push(`address_city_key: ${item.addressCityKey}`);
  if (item.resume) parts.push(`resume: ${item.resume}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export default function QueueList({
  items,
  confirmSlug,
  removing,
  removeError,
  onConfirmChange,
  onRemove,
  onApply,
  applyDisabled,
  applyDisabledReason,
  activeApplySlug,
}: {
  items: QueueItem[];
  confirmSlug: string | null;
  removing: boolean;
  removeError: string | null;
  onConfirmChange: (slug: string | null) => void;
  onRemove: (slug: string) => void;
  onApply: (slug: string) => void;
  applyDisabled: boolean;
  applyDisabledReason?: string;
  activeApplySlug?: string | null;
}) {
  return (
    <div className="rb-surface rb-job-search-stack">
      <div className="rb-list-panel card">
        <div className="rb-list-panel-head head">
          <h2 className="rb-h-major">Up next</h2>
          <p className={removeError ? "rb-section-note crit note" : "rb-section-note note"}>
            {removeError
              ? `Remove failed: ${removeError}`
              : removing
                ? "removing…"
                : `${items.length} on shortlist`}
          </p>
        </div>

        {items.length === 0 ? (
          <div className="rb-empty state">
            <span className="glyph" aria-hidden="true">∅</span>
            <p>Your shortlist is empty — nothing is ready to apply next.</p>
            <p>Add a job below or add one from found jobs.</p>
          </div>
        ) : (
          <div className="rb-list-panel-body table-scroll rb-record-list">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Role</th>
                  <th>Company</th>
                  <th>Job URL</th>
                  <th>Added</th>
                  <th>Overrides</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.slug} className="row" onClick={() => onConfirmChange(null)}>
                    <td className="pos num" data-label="#">
                      <span className="pos-num">{item.position + 1}</span>
                      {item.position === 0 && (
                        <span title="/apply-next consumes the first file in this order">
                          <Stamp tone="accent">next</Stamp>
                        </span>
                      )}
                    </td>
                    <td data-label="Role" className="rb-stack-skip-label">
                      <div className="rb-record-title">{item.title ?? "—"}</div>
                      <div className="rb-record-sub slug" title={item.filePath}>
                        {item.slug}
                        {activeApplySlug === item.slug && (
                          <span className="slug" title="Removing stops the current run">
                            {" "}
                            — run active
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label="Company">
                      <div className="co">{item.company ?? item.slug}</div>
                    </td>
                    <td className="url" data-label="Job URL">
                      {item.url ? (
                        isHttpUrl(item.url) ? (
                          <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            {item.url}
                          </a>
                        ) : (
                          <span title="not an http(s) URL — shown as text, not linked">{item.url}</span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num" data-label="Added">
                      {formatDate(item.queuedAt)}
                    </td>
                    <td className="slug" data-label="Overrides">{overrideSummary(item)}</td>
                    <td data-label="Actions">
                      <span className="row-actions">
                        <button
                          type="button"
                          className="row-btn"
                          disabled={applyDisabled}
                          title={applyDisabled ? applyDisabledReason ?? "Apply is disabled" : undefined}
                          aria-label={`Apply now to ${item.company ?? item.slug} — ${item.title ?? "untitled role"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onApply(item.slug);
                          }}
                        >
                          Apply now
                        </button>
                        {confirmSlug === item.slug ? (
                          <>
                            <button
                              type="button"
                              className="row-btn"
                              disabled={removing}
                              title={
                                activeApplySlug === item.slug ? "Removing stops the current run" : undefined
                              }
                              aria-label={`Confirm removing ${item.company ?? item.slug} — ${item.title ?? "untitled role"} from the queue`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemove(item.slug);
                              }}
                            >
                              Confirm remove
                            </button>
                            <button
                              type="button"
                              className="row-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                onConfirmChange(null);
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="row-btn"
                            aria-label={`Remove ${item.company ?? item.slug} — ${item.title ?? "untitled role"} from the queue`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onConfirmChange(item.slug);
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details className="rb-footnotes">
        <summary>About this list</summary>
        <p className="note">The date is when the job was added to your shortlist.</p>
        <p className="note">Overrides are notes the agent reads when applying. Rolebound does not enforce them automatically.</p>
        <p className="note">Remove deletes the job from your shortlist and cannot be undone.</p>
      </details>
    </div>
  );
}

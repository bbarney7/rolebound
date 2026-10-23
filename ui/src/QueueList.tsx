import type { QueueItem } from "../shared/types";
import Stamp from "./Stamp";
import "./surfaces.css";

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
    <div className="rb-surface">
      <div className="rb-list-panel card">
        <div className="rb-list-panel-head head">
          <h2 className="rb-h-major">Preparation queue</h2>
          <p className={removeError ? "rb-section-note crit note" : "rb-section-note note"}>
            {removeError
              ? `Remove failed: ${removeError}`
              : removing
                ? "removing…"
                : `${items.length} queued`}
          </p>
        </div>

        {items.length === 0 ? (
          <div className="rb-empty state">
            <span className="glyph" aria-hidden="true">∅</span>
            <p>The queue is empty — nothing is ready to apply next.</p>
            <p>Add one below or promote a discovered job.</p>
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
                  <th>In queue since</th>
                  <th>Overrides</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.slug} className="row" onClick={() => onConfirmChange(null)}>
                    <td className="pos num">
                      <span className="pos-num">{item.position + 1}</span>
                      {item.position === 0 && (
                        <span title="/apply-next consumes the first file in this order">
                          <Stamp tone="accent">next</Stamp>
                        </span>
                      )}
                    </td>
                    <td>
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
                    <td>
                      <div className="co">{item.company ?? item.slug}</div>
                    </td>
                    <td className="url">
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
                    <td className="num">
                      {formatDate(item.queuedAt)}
                      <span className="slug" title="file change time, not a recorded queue timestamp"> ‡</span>
                    </td>
                    <td className="slug">{overrideSummary(item)}</td>
                    <td>
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

      <div className="rb-footnotes">
        <p className="note">
          ‡ file change time. For a job promoted from discovery this is the moment it was
          promoted; for a job added here it is the moment it was created.
        </p>
        <p className="note">
          Advisory overrides are written into the queue file frontmatter for the agent to read — nothing enforces them in code.
        </p>
        <p className="note">
          Rows are listed in filename sort order. Removing a row deletes its file and cannot be undone.
        </p>
      </div>
    </div>
  );
}

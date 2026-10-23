import { useState } from "react";
import type { DiscoveredItem, QueueCreateBody } from "../shared/types";
import { addQueueItem, fetchDiscovered, promoteQueueItem } from "./api";
import "./surfaces.css";

function scoreLabel(n: number): string {
  if (n >= 5) return "strong";
  if (n === 4) return "good";
  if (n === 3) return "fair";
  return "weak";
}

const EMPTY_FORM = {
  url: "",
  company: "",
  title: "",
  location: "",
  source: "",
  ats: "",
  body: "",
  resumeKey: "",
  addressCityKey: "",
  slug: "",
};

export default function QueueAdd({
  onMutated,
}: {
  onMutated: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DiscoveredItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [promotingSlug, setPromotingSlug] = useState<string | null>(null);

  function setField(key: keyof typeof EMPTY_FORM, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function optional(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  function handleCreate(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body: QueueCreateBody = {
      url: form.url.trim(),
      company: form.company.trim(),
      title: form.title.trim(),
      location: form.location.trim(),
      source: optional(form.source),
      ats: optional(form.ats),
      body: optional(form.body),
      resumeKey: optional(form.resumeKey),
      addressCityKey: optional(form.addressCityKey),
      slug: optional(form.slug),
    };
    setSubmitting(true);
    setSubmitError(null);
    setWarning(null);
    addQueueItem(body)
      .then((result) => {
        onMutated();
        setWarning(result.warning);
        setForm(EMPTY_FORM);
        setSubmitting(false);
        setAddOpen(false);
      })
      .catch((e) => {
        setSubmitError(String(e));
        setSubmitting(false);
      });
  }

  function runSearch(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    fetchDiscovered(query.trim())
      .then((items) => {
        setResults(items);
        setSearching(false);
      })
      .catch((e) => {
        setSearchError(String(e));
        setSearching(false);
      });
  }

  function handlePromote(slug: string) {
    setPromotingSlug(slug);
    setSubmitError(null);
    setWarning(null);
    promoteQueueItem({ slug })
      .then((result) => {
        onMutated();
        setWarning(result.warning);
        setResults((prev) => prev.filter((r) => r.slug !== slug));
        setPromotingSlug(null);
      })
      .catch((e) => {
        setSubmitError(String(e));
        setPromotingSlug(null);
      });
  }

  function loadDiscoveries() {
    if (results.length === 0 && !searching) {
      setSearching(true);
      setSearchError(null);
      fetchDiscovered("")
        .then((items) => {
          setResults(items);
          setSearching(false);
        })
        .catch((e) => {
          setSearchError(String(e));
          setSearching(false);
        });
    }
  }

  const addStatus =
    submitError
      ? `Add failed: ${submitError}`
      : submitting
        ? "Adding…"
        : warning
          ? `Added with a warning: ${warning}`
          : null;

  return (
    <div className="rb-surface rb-queue-add">
      <details className="rb-queue-add-panel" open={addOpen} onToggle={(e) => setAddOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Add a role manually</summary>
        <form className="rb-settings-form" onSubmit={handleCreate}>
          <p className="rb-queue-add-lead">Paste a job posting URL and the basics the agent needs to open the form.</p>

          <div className="rb-settings-grid">
            <div className="rb-profile-field rb-settings-span2">
              <label htmlFor="add-url">Job URL</label>
              <input
                id="add-url"
                className="control"
                type="url"
                required
                placeholder="https://…"
                value={form.url}
                onChange={(e) => setField("url", e.target.value)}
              />
            </div>
            <div className="rb-profile-field">
              <label htmlFor="add-company">Company</label>
              <input id="add-company" className="control" type="text" required value={form.company} onChange={(e) => setField("company", e.target.value)} />
            </div>
            <div className="rb-profile-field">
              <label htmlFor="add-title">Role title</label>
              <input id="add-title" className="control" type="text" required value={form.title} onChange={(e) => setField("title", e.target.value)} />
            </div>
            <div className="rb-profile-field rb-settings-span2">
              <label htmlFor="add-location">Location</label>
              <input id="add-location" className="control" type="text" required placeholder="e.g. Remote, Denver CO" value={form.location} onChange={(e) => setField("location", e.target.value)} />
            </div>
          </div>

          <details className="rb-tech-details">
            <summary>More fields (optional)</summary>
            <div className="rb-settings-grid">
              <div className="rb-profile-field">
                <label htmlFor="add-source">Source</label>
                <input id="add-source" className="control" type="text" value={form.source} onChange={(e) => setField("source", e.target.value)} />
              </div>
              <div className="rb-profile-field">
                <label htmlFor="add-ats">ATS</label>
                <input id="add-ats" className="control" type="text" value={form.ats} onChange={(e) => setField("ats", e.target.value)} />
              </div>
              <div className="rb-profile-field rb-settings-span2">
                <label htmlFor="add-body">Job description</label>
                <textarea id="add-body" className="control tall" rows={4} value={form.body} onChange={(e) => setField("body", e.target.value)} />
              </div>
            </div>
          </details>

          <details className="rb-tech-details">
            <summary>Advanced overrides</summary>
            <p className="rb-hint">Hint the agent toward a specific resume or address. Not enforced — written as advisory metadata only.</p>
            <div className="rb-settings-grid">
              <div className="rb-profile-field">
                <label htmlFor="add-resume-key">Resume key</label>
                <input id="add-resume-key" className="control" type="text" value={form.resumeKey} onChange={(e) => setField("resumeKey", e.target.value)} />
              </div>
              <div className="rb-profile-field">
                <label htmlFor="add-address-city-key">Address city key</label>
                <input id="add-address-city-key" className="control" type="text" value={form.addressCityKey} onChange={(e) => setField("addressCityKey", e.target.value)} />
              </div>
              <div className="rb-profile-field rb-settings-span2">
                <label htmlFor="add-slug">Custom file name</label>
                <input id="add-slug" className="control" type="text" value={form.slug} onChange={(e) => setField("slug", e.target.value)} placeholder="Leave blank to derive from company and title" />
              </div>
            </div>
          </details>

          <div className="rb-form-actions">
            <button type="submit" className="btn primary" disabled={submitting}>
              {submitting ? "Adding…" : "Add to queue"}
            </button>
          </div>
          {addStatus && <p className={submitError ? "rb-form-status crit" : "rb-form-status"} aria-live="polite">{addStatus}</p>}
        </form>
      </details>

      <details className="rb-queue-add-panel" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadDiscoveries(); }}>
        <summary>Promote from discoveries</summary>
        <div className="rb-queue-promote">
            <form className="rb-promote-search" onSubmit={runSearch}>
              <div className="rb-profile-field">
                <label htmlFor="promote-search">Search discoveries</label>
                <input
                  id="promote-search"
                  className="control"
                  type="search"
                  placeholder="Company, role, or location"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="rb-form-actions">
                <button type="submit" className="btn" disabled={searching}>Search</button>
              </div>
            </form>

            <p className={searchError ? "rb-form-status crit" : "rb-form-status"}>
              {searchError
                ? `Search failed: ${searchError}`
                : searching
                  ? "Searching…"
                  : `${results.length} result${results.length === 1 ? "" : "s"} — best matches first`}
            </p>

            {results.length > 0 && (
              <div className="table-scroll rb-record-list">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th>Company</th>
                      <th>Location</th>
                      <th>Fit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((item) => (
                      <tr key={item.slug}>
                        <td>
                          <div className="rb-record-title">{item.title ?? "—"}</div>
                          <div className="rb-record-sub slug">{item.slug}</div>
                        </td>
                        <td>{item.company ?? item.slug}</td>
                        <td>{item.location ?? "—"}</td>
                        <td>
                          {item.llmScore === null ? "—" : (
                            <span><span className="score">{item.llmScore}</span> {scoreLabel(item.llmScore)}</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="row-btn"
                            disabled={promotingSlug !== null}
                            aria-label={`Promote ${item.company ?? item.slug} — ${item.title ?? "untitled role"} to the queue`}
                            onClick={() => handlePromote(item.slug)}
                          >
                            {promotingSlug === item.slug ? "Promoting…" : "Promote"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </details>
    </div>
  );
}

import { readState, normalizeStateApplication, normalizeApplyState, inferSourceFromUrl } from "./readers/stateJson";
import { listJobFiles, readJobFile, type JobFileRecord } from "./readers/jobFiles";
import { readUiState } from "./uiState";
import type { Application, UiState } from "../shared/types";

/** Synthesize an Application from an applied/*.md file with no state.json record. */
export function synthesizeFromJobFile(file: JobFileRecord): Application {
  // provenance chain: submitted_at → applied_at → file mtime
  const submittedAt = file.submittedAt ?? file.appliedAt ?? file.mtime;
  return {
    slug: file.slug,
    url: file.url,
    company: file.company,
    title: file.title,
    location: file.location,
    source: file.source ?? inferSourceFromUrl(file.url),
    applyState: file.status ? normalizeApplyState(file.status) : "submitted",
    pipelineStatus: null,
    pipelineExplicit: false,
    submittedAt,
    estimated: true,
    resumePath: file.resume,
    resumeKey: file.resumeKey,
    addressCityKey: file.addressCityKey,
    addressUsed: null,
    attempts: [],
    screenshot: file.screenshot,
    verificationEmailId: null,
    abortReason: null,
    blockReason: null,
    jobFilePath: file.filePath,
    descriptionExcerpt: file.descriptionExcerpt,
    // md-only rows have no state.json entry, so there is no recorded queue_file
    queueFile: null,
    userNotes: null,
    lastUpdated: submittedAt,
  };
}

/**
 * Merge posting metadata from an applied md file into a state-backed Application.
 * state.json stays authoritative for run/submission data; md only fills gaps.
 */
export function mergeJobFileInto(app: Application, file: JobFileRecord): void {
  app.jobFilePath = file.filePath;
  app.descriptionExcerpt = file.descriptionExcerpt;
  if (!app.source) app.source = file.source;
  if (!app.location) app.location = file.location;
  if (!app.url) app.url = file.url;
  if (!app.company) app.company = file.company;
  if (!app.title) app.title = file.title;
}

export function applyUiOverlay(app: Application, uiState: UiState): void {
  const ui = uiState.applications[app.slug];
  if (ui?.pipelineStatus) {
    app.pipelineStatus = ui.pipelineStatus;
    app.pipelineExplicit = true;
  } else if (app.applyState === "submitted") {
    app.pipelineStatus = "submitted";
  }
  app.userNotes = ui?.userNotes ?? null;
}

/**
 * Read-time history union: state.json ∪ jobs/applied/*.md, merged by slug.
 * Collisions are the normal future state (every successful /apply-next writes
 * both sources) — state.json authoritative, md supplies posting metadata.
 */
export async function listApplications(root: string): Promise<Application[]> {
  const [state, appliedFiles, uiState] = await Promise.all([
    readState(root),
    listJobFiles(root, "applied"),
    readUiState(root),
  ]);

  const bySlug = new Map<string, Application>();
  for (const raw of state.applications) {
    const app = normalizeStateApplication(raw, state.lastUpdated);
    bySlug.set(app.slug, app);
  }
  for (const file of appliedFiles) {
    const existing = bySlug.get(file.slug);
    if (existing) {
      mergeJobFileInto(existing, file);
    } else {
      bySlug.set(file.slug, synthesizeFromJobFile(file));
    }
  }
  for (const app of bySlug.values()) {
    applyUiOverlay(app, uiState);
  }

  // newest first; entries without dates sink to the bottom, slug tiebreak
  return [...bySlug.values()].sort(
    (a, b) =>
      (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") ||
      a.slug.localeCompare(b.slug),
  );
}

/**
 * Single-application accessor for the detail route: 3 file reads instead of
 * listApplications' 70+. It must build the entry in exactly the same order as
 * listApplications, because a forked derivation drifts silently from
 * /api/overview's byPipelineStatus histogram. union.test.ts's deep-equal
 * fidelity test is what keeps the two in step.
 */
export async function getApplication(root: string, slug: string): Promise<Application | null> {
  const [state, file, uiState] = await Promise.all([
    readState(root),
    readJobFile(root, "applied", slug),
    readUiState(root),
  ]);

  // listApplications keys its Map by the NORMALIZED slug (raw.slug ?? "unknown")
  // and bySlug.set lets a later duplicate overwrite an earlier one — so match on
  // the coalesced value and keep the LAST match, not the first.
  let app: Application | null = null;
  for (const raw of state.applications) {
    if ((raw.slug ?? "unknown") === slug) {
      app = normalizeStateApplication(raw, state.lastUpdated);
    }
  }

  if (app) {
    if (file) mergeJobFileInto(app, file);
  } else if (file) {
    app = synthesizeFromJobFile(file);
  } else {
    return null;
  }

  // applyUiOverlay is NOT idempotent — it never clears a stale
  // pipelineExplicit: true — so it may only ever touch a freshly built object.
  applyUiOverlay(app, uiState);
  return app;
}

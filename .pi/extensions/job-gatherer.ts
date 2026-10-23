/**
 * Job Gatherer Agent — Pi Extension
 *
 * Auto-loads when pi runs from the workspace root (the repo you cloned).
 * Discovers job postings from public ATS JSON APIs (Greenhouse, Ashby, Lever),
 * filters them against the target profile in `profile.md`, dedups against the
 * applier's state, and writes candidates to jobs/discovered/<slug>.md for review
 * before promotion to jobs/queue/ (which the job-applier extension consumes).
 *
 * Provides:
 * - System prompt injection with gatherer workflow rules
 * - Custom tools: discover_*_board, gather_all, dedup_check, promote_to_queue,
 *   reject_discovered, list_targets, add_target, gather_status,
 *   score_discovered, score_job
 * - Slash commands: /gather, /gather-greenhouse, /review-discovered,
 *   /score-discovered, /targets, /gather-status
 *
 * See JOB-GATHERER-PLAN.md for the full design. Phase 1 MVP: Greenhouse +
 * Ashby + Lever via public JSON APIs; no browser.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs/promises";
import { WORKSPACE, wsPath, isInWorkspace } from "./lib/workspace";
import {
  filterRulesFromProfile,
  matchJob,
  normalizeLocation,
  type FilterRules,
  type MatchResult,
} from "./lib/gather-filters";
import { loadProfileOrEmpty } from "./lib/profile";
import { scoringBlockedByPlaceholders } from "../../ui/shared/profilePlaceholders";
import { formatFindingInstructionsBlock, readInstructions } from "./lib/instructions";
import { buildScoringPrompt, scoreDiscoveredJobFile, type LLMScore } from "./lib/scoring";
import { parseTargets, type TargetEntry, withTargetsLock } from "./lib/targets";
import {
  mergeGatherResults,
  mutateGatherState,
  promoteDiscovered,
  readGatherStateStrict,
  rejectDiscovered as rejectDiscoveredStore,
  writeDiscoveredJob,
  type SeenEntry,
} from "./lib/gather-store";
import { atomicCreateFile, atomicWriteFile, readJsonFile, WorkspaceFileError } from "./lib/durable-store";
import { corruptFileRecoveryMessage } from "./lib/accounts-store";
import { isSafeSlug, parseStateText, type ParsedGatherState } from "./lib/workspace-files";
import {
  ashbyBoardUrl,
  atsFetchInit,
  greenhouseBoardJobsUrl,
  leverBoardUrl,
} from "./lib/ats-origin";

// ── Title / slug helpers ──

const TITLE_STOPWORDS = [
  "senior", "sr", "sr.", "staff", "manager", "manager,", "of", "engineering",
  "the", "and", "&", "-", "—", "ai", "ml", "platform", "products", "product",
  "a", "to", "for", "in", "on", "with", "director", "lead", "head",
];

function shortTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TITLE_STOPWORDS.includes(w));
  let s = words.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s) {
    // fallback: use the whole title
    s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  return s.slice(0, 50);
}

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function slugify(company: string, title: string): string {
  return `${kebab(company)}-${shortTitle(title)}`;
}

// ── HTML → plain text (lifted from lyt3ral/job-scraper-ts) ──

function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadFilterRules(): Promise<FilterRules> {
  return filterRulesFromProfile(await loadProfileOrEmpty());
}

// ── State I/O ──

interface SeenEntry {
  first_seen: string;
  source: string;
  company: string;
  title: string;
  decision: "discovered" | "rejected" | "promoted";
  reject_reason?: string;
}

interface GatherState {
  seen_urls: Record<string, SeenEntry>;
  per_company: Record<string, {
    last_fetched: string | null;
    openings_count: number;
    matched_count: number;
    error?: string;
  }>;
  last_full_gather: string | null;
  auto_promote: boolean;
}

async function readGatherState(): Promise<GatherState> {
  try {
    const raw = await fs.readFile(wsPath("gather_state.json"), "utf-8");
    return JSON.parse(raw) as GatherState;
  } catch {
    return { seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false };
  }
}

async function writeGatherState(state: GatherState): Promise<void> {
  await fs.writeFile(wsPath("gather_state.json"), JSON.stringify(state, null, 2));
}

interface ApplierState {
  applications?: Array<Record<string, unknown>>;
  addresses?: Record<string, unknown>;
  acknowledged_at?: string | null;
}

async function readApplierState(): Promise<ApplierState> {
  const read = await readJsonFile(wsPath("state.json"), parseStateText);
  if (read.state === "missing") return { applications: [], addresses: {} };
  return read.value as ApplierState;
}

async function readTargets(): Promise<TargetEntry[]> {
  try {
    const md = await fs.readFile(wsPath("targets.md"), "utf-8");
    return parseTargets(md);
  } catch {
    return [];
  }
}

// ── Discovered dir + file existence ──

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

// ── Dedup ──

interface DedupResult {
  seen_in: "applied" | "queue" | "discovered" | "state" | null;
  note?: string;
}

async function dedupCheck(url: string, slug: string, company: string, title: string, gstate: GatherState): Promise<DedupResult> {
  // URL-level
  const seen = gstate.seen_urls[url];
  if (seen && seen.decision !== "rejected") {
    return { seen_in: "state", note: `gather_state seen_urls decision=${seen.decision}` };
  }

  // Slug-level across the three dirs.
  const dirs = [
    { dir: wsPath("jobs", "applied"), key: "applied" as const },
    { dir: wsPath("jobs", "queue"), key: "queue" as const },
    { dir: wsPath("jobs", "discovered"), key: "discovered" as const },
  ];
  for (const { dir, key } of dirs) {
    if (await fileExists(`${dir}/${slug}.md`)) {
      return { seen_in: key, note: `${key}/${slug}.md exists` };
    }
  }

  // state.json fuzzy match by company + title.
  const applier = await readApplierState();
  const apps = applier.applications || [];
  const compNorm = normalizeLocation(company);
  const titleNorm = normalizeLocation(title);
  for (const a of apps) {
    const aComp = normalizeLocation(String(a.company || ""));
    const aTitle = normalizeLocation(String(a.title || ""));
    if (aComp === compNorm && aTitle === titleNorm) {
      return { seen_in: "state", note: `state.json ${a.slug}: ${a.status}` };
    }
  }

  return { seen_in: null };
}

// ── LLM scoring through the configured app-owned pi runtime ──
//
// The regex matchJob() is a coarse first filter — it catches "Director of
// Engineering, AI Agents" but can't distinguish a genuinely good fit from a
// role that merely has "AI" in the title. This scoring step sends each
// discovered job to a cheaper model (Kimi K2.6) with a compact profile
// summary and gets back a 1–5 fit score + one-sentence reasoning.
//
// Scores are written into the discovered file frontmatter as:
//   llm_score: 1-5
//   llm_reasoning: "one sentence"
//   llm_scored_at: iso

async function readProfileMarkdown(): Promise<string> {
  try {
    return await fs.readFile(wsPath("profile.md"), "utf-8");
  } catch {
    return "";
  }
}

async function profileSummary(): Promise<string | null> {
  return (await loadProfileOrEmpty()).candidateSummary;
}

async function scoreDiscoveredSlug(
  slug: string,
  job: {
    title: string;
    company: string;
    location: string;
    description: string;
    url: string;
  },
  signal?: AbortSignal,
): Promise<{ ok: true; result: LLMScore; attempts: number } | { ok: false; error: string; attempts: number }> {
  const profileMd = await readProfileMarkdown();
  const placeholderError = scoringBlockedByPlaceholders(profileMd);
  if (placeholderError) {
    return { ok: false, error: placeholderError, attempts: 0 };
  }
  const summary = await profileSummary();
  if (!summary) {
    return {
      ok: false,
      error:
        "profile.md has nothing to describe the candidate with. Add a `## Candidate summary` " +
        "section (or an `## Identity` + `## Work history`) before scoring jobs.",
      attempts: 0,
    };
  }
  if (!job.description.trim()) return { ok: false, error: "Job description is missing", attempts: 0 };
  const filePath = wsPath("jobs", "discovered", `${slug}.md`);
  const useJev = process.env.PI_JOBS_SCORING_KIND === "jev-openrouter" || process.env.PI_JOBS_SCORING_KIND === "jev-typesafe";
  const { finding } = await readInstructions(WORKSPACE);
  const result = await scoreDiscoveredJobFile(filePath, buildScoringPrompt(summary, job, finding), {
    signal,
    env: process.env,
    ...(useJev ? { jev: { summary, job: { title: job.title, company: job.company, location: job.location, description: job.description } } } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error, attempts: result.attempts };
  return { ok: true, result: result.result, attempts: result.attempts };
}

// Batch-score all unscored discovered files.
interface ScoreSummary {
  scored: number;
  skipped: number;
  errors: Array<{ slug: string; error: string }>;
  jobs: Array<{ slug: string; attempts: number; cost?: number }>;
}

async function scoreAllDiscovered(signal?: AbortSignal): Promise<ScoreSummary> {
  const summary: ScoreSummary = { scored: 0, skipped: 0, errors: [], jobs: [] };
  const profileMd = await readProfileMarkdown();
  const placeholderError = scoringBlockedByPlaceholders(profileMd);
  if (placeholderError) {
    return { ...summary, errors: [{ slug: "", error: placeholderError }] };
  }
  const dir = wsPath("jobs", "discovered");
  const files = (await listDir(dir)).filter((f) => f.endsWith(".md")).sort();
  let requested: Set<string> | null = null;
  try { const parsed = JSON.parse(process.env.PI_JOBS_SCORE_SLUGS || "null"); if (Array.isArray(parsed)) requested = new Set(parsed.filter(value => typeof value === "string")); } catch { return { ...summary, errors: [{ slug: "", error: "Invalid scoring selection" }] }; }
  const pending: Array<{ slug: string; raw: string; fm: Record<string, string> }> = [];
  const found = new Set<string>();
  for (const f of files) {
    const slug = f.replace(".md", "");
    if (requested && !requested.has(slug)) continue;
    found.add(slug);
    const raw = await fs.readFile(`${dir}/${f}`, "utf-8").catch(() => "");
    const fm = parseFrontmatter(raw);

    // Skip already-scored files.
    if (fm.llm_score || fm.dismissed === "true") {
      summary.skipped++;
      continue;
    }
    if (pending.length < 50) pending.push({ slug, raw, fm });
  }
  if (requested) for (const slug of requested) if (!found.has(slug)) summary.errors.push({ slug, error: "Discovered job not found" });
  let cursor = 0;
  const worker = async () => { while (!signal?.aborted) {
    const item = pending[cursor++]; if (!item) return; const { slug, raw, fm } = item;
    try {
      const result = await scoreDiscoveredSlug(slug, {
        title: fm.title || "",
        company: fm.company || "",
        location: fm.location || "",
        description: raw.split("---").slice(2).join("---").trim(), // body after frontmatter
        url: fm.url || "",
      }, signal);
      summary.jobs.push({ slug, attempts: result.attempts, ...(result.ok && result.result.usageCost !== undefined ? { cost: result.result.usageCost } : {}) });
      if (result.ok) summary.scored++;
      else summary.errors.push({ slug, error: result.error });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({
        slug,
        error: message.includes("job changed while scoring") ? "Job changed while scoring" : message,
      });
    }
  } };
  await Promise.all([worker(), worker()]);

  return summary;
}

// ── HTTP fetch helpers ──

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── ATS source fetchers ──

export interface RawJob {
  title: string;
  location: string;
  url: string; // apply URL
  reqId: string;
  description: string;
  source: "greenhouse" | "ashby" | "lever";
  company: string;
  publishedAt?: string;
}

async function fetchGreenhouseBoard(slug: string): Promise<{ jobs: RawJob[]; total: number; error?: string }> {
  const url = greenhouseBoardJobsUrl(slug);
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      ...atsFetchInit(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { jobs: [], total: 0, error: `HTTP ${resp.status}: ${body.slice(0, 150)}` };
    }
    const data = (await resp.json()) as {
      jobs: Array<{
        id: number;
        title: string;
        absolute_url: string;
        location: { name: string } | null;
        content?: string;
        departments?: { name: string }[];
        offices?: { name: string; location?: string }[];
        first_published?: string;
        updated_at?: string;
        requisition_id?: string;
      }>;
      meta: { total: number };
    };
    const jobs: RawJob[] = (data.jobs || []).map((j) => ({
      title: j.title,
      location: j.location?.name || (j.offices && j.offices[0]?.name) || "",
      url: j.absolute_url,
      reqId: String(j.id),
      description: stripHtml(j.content || ""),
      source: "greenhouse" as const,
      company: slug,
      publishedAt: j.first_published || j.updated_at,
    }));
    return { jobs, total: data.meta?.total ?? jobs.length };
  } catch (err) {
    return { jobs: [], total: 0, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function fetchAshbyBoard(slug: string): Promise<{ jobs: RawJob[]; total: number; error?: string }> {
  const url = ashbyBoardUrl(slug);
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      ...atsFetchInit(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { jobs: [], total: 0, error: `HTTP ${resp.status}: ${body.slice(0, 150)}` };
    }
    const data = (await resp.json()) as {
      jobs: Array<{
        id: string;
        title: string;
        location: string;
        jobUrl: string;
        applyUrl?: string;
        descriptionPlain?: string;
        descriptionHtml?: string;
        publishedAt?: string;
        secondaryLocations?: { location: string }[];
        isRemote?: boolean;
      }>;
    };
    const jobs: RawJob[] = (data.jobs || []).map((j) => ({
      title: j.title,
      location: j.location || (j.secondaryLocations && j.secondaryLocations[0]?.location) || "",
      url: j.jobUrl,
      reqId: j.id,
      description: (j.descriptionPlain || "").trim() || stripHtml(j.descriptionHtml || ""),
      source: "ashby" as const,
      company: slug,
      publishedAt: j.publishedAt,
    }));
    return { jobs, total: jobs.length };
  } catch (err) {
    return { jobs: [], total: 0, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function fetchLeverBoard(slug: string): Promise<{ jobs: RawJob[]; total: number; error?: string }> {
  const url = leverBoardUrl(slug);
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      ...atsFetchInit(),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { jobs: [], total: 0, error: `HTTP ${resp.status}: ${body.slice(0, 150)}` };
    }
    const data = (await resp.json()) as Array<{
      id: string;
      text: string;
      hostedUrl: string;
      applyUrl?: string;
      categories?: { location?: string; team?: string };
      descriptionPlain?: string;
      description?: string;
      createdAt?: number;
    }>;
    const jobs: RawJob[] = (data || []).map((j) => ({
      title: j.text,
      location: j.categories?.location || "",
      url: j.hostedUrl,
      reqId: j.id,
      description: (j.descriptionPlain || "").trim() || stripHtml(j.description || ""),
      source: "lever" as const,
      company: slug,
      publishedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    }));
    return { jobs, total: jobs.length };
  } catch (err) {
    return { jobs: [], total: 0, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Company display name (best-effort) ──

function companyDisplayName(slug: string): string {
  // Title-case the slug; common overrides.
  const overrides: Record<string, string> = {
    hubspotjobs: "HubSpot",
    doordashusa: "DoorDash",
    dbtlabsinc: "dbt Labs",
    remotecom: "Remote",
    sourcegraph91: "Sourcegraph",
    wandb: "Weights & Biases",
    scaleai: "Scale AI",
  };
  if (overrides[slug]) return overrides[slug];
  return slug
    .split(/[-_\s]+/)
    .map((w) => (w.length <= 1 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ── Write a discovered file ──

async function writeDiscoveredFile(job: RawJob, m: MatchResult): Promise<void> {
  const slug = slugify(job.company, job.title);
  const dir = wsPath("jobs", "discovered");
  await fs.mkdir(dir, { recursive: true });
  const company = companyDisplayName(job.company);
  const now = new Date().toISOString();
  const body = [
    "---",
    `url: ${job.url}`,
    `company: ${company}`,
    `title: ${job.title}`,
    `location: ${job.location || (m.remote ? "Remote" : "Unknown")}`,
    `source: ${job.source}`,
    `match: ${m.match}`,
    `discovered_at: ${now}`,
    "---",
    "",
    `ATS: ${job.source}`,
    `Role match: ${m.roleHit ? `"${m.roleHit}"` : "(none)"}` + (m.topicHit ? ` + topic "${m.topicHit}"` : ""),
    `Location key: ${m.locationKey}${m.remote ? " (remote)" : ""}`,
    `Req ID: ${job.reqId}`,
    job.publishedAt ? `Published: ${job.publishedAt}` : "",
    "",
    "Description excerpt:",
    job.description.slice(0, 600),
  ].filter((l) => l !== "").join("\n");
  await writeDiscoveredJob(`jobs/discovered/${slug}.md`, body + "\n");
}

// ── The big gather routine ──

interface GatherSummary {
  discovered: number;
  weak: number;
  skippedFilters: number;
  alreadySeen: number;
  errors: Array<{ company: string; source: string; error: string }>;
  companiesScanned: number;
  totalOpenings: number;
}

async function gatherAll(opts: { sources?: string[]; singleGreenhouse?: string }): Promise<GatherSummary> {
  const summary: GatherSummary = {
    discovered: 0,
    weak: 0,
    skippedFilters: 0,
    alreadySeen: 0,
    errors: [],
    companiesScanned: 0,
    totalOpenings: 0,
  };

  const initial = await readGatherStateStrict();
  if ("error" in initial) {
    throw initial.error;
  }
  const snapshot = JSON.parse(JSON.stringify(initial.seen_urls ?? {})) as Record<string, SeenEntry>;
  const gstate = {
    ...initial,
    seen_urls: { ...(initial.seen_urls as Record<string, SeenEntry>) },
    per_company: { ...(initial.per_company as Record<string, unknown>) },
  } as GatherState;
  const gatheredCompanies: string[] = [];
  const filterRules = await loadFilterRules();
  let targets: TargetEntry[];
  if (opts.singleGreenhouse) {
    targets = [{ source: "greenhouse", slug: opts.singleGreenhouse }];
  } else {
    targets = await readTargets();
    if (opts.sources && opts.sources.length > 0) {
      const want = new Set(opts.sources.map((s) => s.toLowerCase()));
      targets = targets.filter((t) => want.has(t.source));
    }
  }

  try {
    for (const target of targets) {
      const company = target.slug;
      gatheredCompanies.push(company);
      summary.companiesScanned++;
      let result: { jobs: RawJob[]; total: number; error?: string };
      if (target.source === "greenhouse") {
        result = await fetchGreenhouseBoard(target.slug);
      } else if (target.source === "ashby") {
        result = await fetchAshbyBoard(target.slug);
      } else {
        result = await fetchLeverBoard(target.slug);
      }

      if (result.error) {
        summary.errors.push({ company, source: target.source, error: result.error });
        gstate.per_company[company] = {
          last_fetched: new Date().toISOString(),
          openings_count: 0,
          matched_count: 0,
          error: result.error,
        };
        await sleep(300); // gentle
        continue;
      }

      summary.totalOpenings += result.total;
      let matched = 0;

      for (const job of result.jobs) {
        // Rate-limit lightly between processing; fetches already happened.
        const m = matchJob(job.title, job.description, job.location, filterRules);

        if (m.match === "skip") {
          summary.skippedFilters++;
          continue;
        }

        const slug = slugify(job.company, job.title);
        const dup = await dedupCheck(job.url, slug, job.company, job.title, gstate);
        if (dup.seen_in) {
          summary.alreadySeen++;
          // Still record the URL as seen if not already.
          if (!gstate.seen_urls[job.url]) {
            gstate.seen_urls[job.url] = {
              first_seen: new Date().toISOString(),
              source: target.source,
              company: companyDisplayName(job.company),
              title: job.title,
              decision: "rejected",
              reject_reason: `dup of ${dup.seen_in}: ${dup.note || ""}`,
            };
          }
          continue;
        }

        // Write discovered file (strong or weak).
        await writeDiscoveredFile(job, m);
        matched++;
        if (m.match === "strong") summary.discovered++;
        else summary.weak++;

        gstate.seen_urls[job.url] = {
          first_seen: new Date().toISOString(),
          source: target.source,
          company: companyDisplayName(job.company),
          title: job.title,
          decision: "discovered",
        };
      }

      gstate.per_company[company] = {
        last_fetched: new Date().toISOString(),
        openings_count: result.total,
        matched_count: matched,
      };

      await sleep(500); // be polite between companies
    }

    gstate.last_full_gather = new Date().toISOString();
  } finally {
    const merged = await mutateGatherState((current) =>
      mergeGatherResults(current, snapshot, gstate as ParsedGatherState, gatheredCompanies),
    );
    if ("error" in merged) {
      throw merged.error;
    }
  }

  return summary;
}

// ── Promote / reject ──

async function promoteToQueue(slug: string) {
  return promoteDiscovered(slug);
}

async function rejectDiscovered(slug: string, reason: string) {
  return rejectDiscoveredStore(slug, reason);
}

// ── Read discovered files for review ──

interface DiscoveredItem {
  slug: string;
  company: string;
  title: string;
  location: string;
  source: string;
  match: string;
  url: string;
  llm_score?: string;
  llm_reasoning?: string;
}

function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
}

async function listDiscovered(): Promise<DiscoveredItem[]> {
  const dir = wsPath("jobs", "discovered");
  const files = (await listDir(dir)).filter((f) => f.endsWith(".md"));
  const items: DiscoveredItem[] = [];
  for (const f of files) {
    const raw = await fs.readFile(`${dir}/${f}`, "utf-8").catch(() => "");
    const fm = parseFrontmatter(raw);
    items.push({
      slug: f.replace(".md", ""),
      company: fm.company || "?",
      title: fm.title || "?",
      location: fm.location || "?",
      source: fm.source || "?",
      match: fm.match || "?",
      url: fm.url || "",
      llm_score: fm.llm_score,
      llm_reasoning: fm.llm_reasoning,
    });
  }
  // Sort by LLM score (desc, unscored last), then by regex match strength, then company
  items.sort((a, b) => {
    const sa = a.llm_score ? parseInt(a.llm_score) : -1;
    const sb = b.llm_score ? parseInt(b.llm_score) : -1;
    if (sa !== sb) return sb - sa; // higher score first, unscored (-1) last
    const rank = (m: string) => (m === "strong" ? 0 : m === "weak" ? 1 : 2);
    return rank(a.match) - rank(b.match) || a.company.localeCompare(b.company);
  });
  return items;
}

export default function jobGathererExtension(pi: ExtensionAPI) {
  // ── System prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isInWorkspace(ctx.cwd)) return;

    const prompt = `## Job Gatherer Agent

You are also a job *discovery* agent. A second pi extension (\`job-gatherer.ts\`) is loaded in this workspace alongside the job applier. Its job is to populate \`jobs/discovered/\` with candidate postings pulled from public ATS JSON APIs, which the user then promotes to \`jobs/queue/\` for the applier to consume.

**Use the registered gatherer tools — do not scrape inline.** Call \`gather_all\`, \`discover_greenhouse_board\`, \`discover_ashby_board\`, \`discover_lever_board\`, \`list_targets\`, \`gather_status\`, \`promote_to_queue\`, \`reject_discovered\`, \`score_discovered\`, \`score_job\` as appropriate.

### Workflow
1. \`/gather\` (or call \`gather_all\`) reads \`targets.md\`, fetches each company's ATS JSON board, filters by role+topic+location, dedups against \`jobs/applied\`, \`jobs/queue\`, \`state.json\`, and \`gather_state.json.seen_urls\`, and writes passing candidates to \`jobs/discovered/<slug>.md\`.
2. \`/score-discovered\` (or call \`score_discovered\`) scores up to 50 unscored discovered jobs with the configured scoring model. Each job gets a 1–5 fit score + concise reasoning written into frontmatter (\`llm_score\`, \`llm_reasoning\`, \`llm_scored_at\`). The regex \`match\` field remains a coarse pre-filter.
3. \`/review-discovered\` lists discovered files sorted by LLM score (highest first), then by regex match strength. Promote scores 4–5 to \`jobs/queue/\`.
4. Promote: \`promote_to_queue({ slug })\` moves a discovered file to \`jobs/queue/\`, after which \`/apply-next\` can apply to it.
5. Reject: \`reject_discovered({ slug, reason })\` removes a discovered file and marks it rejected in \`gather_state.json\`.

### Filter rules
- **Target roles, levels, topics, locations, and title blocklist** come from \`profile.md\`'s \`## Job search preferences\`. When target roles are omitted, generic engineering IC/manager heuristics apply; when provided, only those role terms are used (for example product/design roles).
- **Target topics** fall back to the extension's built-in AI/ML/platform defaults only when profile.md does not declare any.
- **Acceptable locations** are the city keys in \`profile.md\`'s \`## City → Address rules\` table, plus remote-US. A profile with no city rows accepts Remote only.
- Non-US locations are always rejected.

### Files
- \`targets.md\` — curated company list grouped by ATS source (greenhouse/ashby/lever). Edit freely.
- \`gather_state.json\` — seen URLs, per-company fetch stats, auto_promote flag.
- \`jobs/discovered/<slug>.md\` — staging area; frontmatter matches queue format + \`match\` + \`discovered_at\`.

### Do NOT
- Do not auto-promote to \`jobs/queue/\` unless \`gather_state.auto_promote\` is true. Default is review-first.
- Do not re-surface URLs already in \`gather_state.seen_urls\` (unless previously rejected and the job genuinely changed).
- Do not modify \`state.json\`, \`profile.md\`, or \`jobs/queue/\` directly — those belong to the applier. Use \`promote_to_queue\`.
`;
    const { finding } = await readInstructions(WORKSPACE);
    return { systemPrompt: event.systemPrompt + "\n\n" + prompt + formatFindingInstructionsBlock(finding) };
  });

  // ── Tools ──

  pi.registerTool({
    name: "discover_greenhouse_board",
    label: "Discover Greenhouse Board",
    description:
      "Fetch all jobs from a company's public Greenhouse board via the boards-api.greenhouse.io JSON API. " +
      "Returns raw openings (title, location, url, reqId, description) without filtering. " +
      "Use gather_all for the full filtered+deduped pipeline; use this for single-company inspection.",
    parameters: Type.Object({
      company: Type.String({ description: "Greenhouse board token/slug, e.g. 'figma' or 'hubspotjobs'" }),
    }),
    async execute(_toolCallId, params) {
      const result = await fetchGreenhouseBoard(params.company);
      if (result.error) {
        return {
          content: [{ type: "text", text: `Greenhouse board '${params.company}' error: ${result.error}` }],
          details: result,
          isError: true,
        };
      }
      const sample = result.jobs.slice(0, 20).map((j) => `- ${j.title} | ${j.location || "?"} | ${j.url}`);
      return {
        content: [
          {
            type: "text",
            text: `Greenhouse '${params.company}': ${result.total} total jobs. First ${sample.length}:\n${sample.join("\n")}`,
          },
        ],
        details: { total: result.total, jobs: result.jobs },
      };
    },
  });

  pi.registerTool({
    name: "discover_ashby_board",
    label: "Discover Ashby Board",
    description:
      "Fetch all jobs from a company's public Ashby board via the api.ashbyhq.com JSON API. " +
      "Returns raw openings (title, location, jobUrl, description). Use gather_all for the filtered pipeline.",
    parameters: Type.Object({
      company: Type.String({ description: "Ashby board name/slug, e.g. 'langchain'" }),
    }),
    async execute(_toolCallId, params) {
      const result = await fetchAshbyBoard(params.company);
      if (result.error) {
        return {
          content: [{ type: "text", text: `Ashby board '${params.company}' error: ${result.error}` }],
          details: result,
          isError: true,
        };
      }
      const sample = result.jobs.slice(0, 20).map((j) => `- ${j.title} | ${j.location || "?"} | ${j.url}`);
      return {
        content: [
          { type: "text", text: `Ashby '${params.company}': ${result.total} jobs. First ${sample.length}:\n${sample.join("\n")}` },
        ],
        details: { total: result.total, jobs: result.jobs },
      };
    },
  });

  pi.registerTool({
    name: "discover_lever_board",
    label: "Discover Lever Board",
    description:
      "Fetch all jobs from a company's public Lever board via api.lever.co. " +
      "Returns raw openings (title, location, hostedUrl, description). Use gather_all for the filtered pipeline.",
    parameters: Type.Object({
      company: Type.String({ description: "Lever board slug, e.g. 'articulate'" }),
    }),
    async execute(_toolCallId, params) {
      const result = await fetchLeverBoard(params.company);
      if (result.error) {
        return {
          content: [{ type: "text", text: `Lever board '${params.company}' error: ${result.error}` }],
          details: result,
          isError: true,
        };
      }
      const sample = result.jobs.slice(0, 20).map((j) => `- ${j.title} | ${j.location || "?"} | ${j.url}`);
      return {
        content: [
          { type: "text", text: `Lever '${params.company}': ${result.total} jobs. First ${sample.length}:\n${sample.join("\n")}` },
        ],
        details: { total: result.total, jobs: result.jobs },
      };
    },
  });

  pi.registerTool({
    name: "gather_all",
    label: "Gather All",
    description:
      "Read targets.md and run the full discovery pipeline: fetch each company's ATS board, apply role+topic+location filters, dedup against jobs/applied, jobs/queue, state.json, and gather_state.json.seen_urls, and write passing jobs to jobs/discovered/<slug>.md. " +
      "Returns a summary { discovered, weak, skippedFilters, alreadySeen, errors, companiesScanned, totalOpenings }. " +
      "Pass sources=['greenhouse'] or ['ashby','lever'] to limit. Pass singleGreenhouse to gather one company only.",
    parameters: Type.Object({
      sources: Type.Optional(Type.Array(Type.String(), { description: "Optional subset of sources: 'greenhouse', 'ashby', 'lever'" })),
      singleGreenhouse: Type.Optional(Type.String({ description: "If set, gather only this one Greenhouse board slug (ignores targets.md)" })),
    }),
    async execute(_toolCallId, params) {
      const summary = await gatherAll({
        sources: params.sources,
        singleGreenhouse: params.singleGreenhouse,
      });
      const lines = [
        `Gather complete.`,
        `Companies scanned: ${summary.companiesScanned}`,
        `Total openings seen: ${summary.totalOpenings}`,
        `Discovered (strong): ${summary.discovered}`,
        `Discovered (weak): ${summary.weak}`,
        `Skipped by filters: ${summary.skippedFilters}`,
        `Already seen (dedup): ${summary.alreadySeen}`,
        `Errors: ${summary.errors.length}`,
      ];
      if (summary.errors.length > 0) {
        lines.push("Error details:");
        for (const e of summary.errors) lines.push(`- [${e.source}] ${e.company}: ${e.error}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...summary, card: "run-progress" },
      };
    },
  });

  pi.registerTool({
    name: "dedup_check",
    label: "Dedup Check",
    description: "Check whether a job URL/slug is already tracked in applied/, queue/, discovered/, or state.json. Returns { seen_in, note }.",
    parameters: Type.Object({
      url: Type.String({ description: "Job apply URL" }),
      slug: Type.String({ description: "Candidate slug (company-shorttitle)" }),
      company: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (!isSafeSlug(params.slug)) {
        return { content: [{ type: "text", text: `unsafe slug: ${params.slug}` }], isError: true };
      }
      const gstateRead = await readGatherStateStrict();
      if ("error" in gstateRead) {
        return {
          content: [{ type: "text", text: corruptFileRecoveryMessage(gstateRead.error as WorkspaceFileError) }],
          isError: true,
        };
      }
      try {
        await readApplierState();
      } catch (err) {
        if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
          return { content: [{ type: "text", text: corruptFileRecoveryMessage(err) }], isError: true };
        }
        throw err;
      }
      const res = await dedupCheck(
        params.url,
        params.slug,
        params.company || "",
        params.title || "",
        gstateRead as GatherState,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
        details: res,
      };
    },
  });

  pi.registerTool({
    name: "promote_to_queue",
    label: "Promote To Queue",
    description: "Move a discovered job from jobs/discovered/<slug>.md to jobs/queue/<slug>.md so the applier can apply to it via /apply-next. Marks the URL 'promoted' in gather_state.json.",
    parameters: Type.Object({
      slug: Type.String({ description: "Discovered file slug (filename without .md)" }),
    }),
    async execute(_toolCallId, params) {
      if (!isSafeSlug(params.slug)) {
        return { content: [{ type: "text", text: `unsafe slug: ${params.slug}` }], isError: true };
      }
      const res = await promoteToQueue(params.slug);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Promote failed: ${res.error}` }], details: { ...res, card: "job-list", slug: params.slug }, isError: true };
      }
      return { content: [{ type: "text", text: `Promoted ${params.slug} → jobs/queue/. Ready for /apply-next.` }], details: { ...res, card: "job-list", slug: params.slug } };
    },
  });

  pi.registerTool({
    name: "reject_discovered",
    label: "Reject Discovered",
    description: "Delete a discovered job file and mark its URL 'rejected' (with reason) in gather_state.json so it won't be re-surfaced.",
    parameters: Type.Object({
      slug: Type.String({ description: "Discovered file slug" }),
      reason: Type.Optional(Type.String({ description: "Reason for rejection" })),
    }),
    async execute(_toolCallId, params) {
      if (!isSafeSlug(params.slug)) {
        return { content: [{ type: "text", text: `unsafe slug: ${params.slug}` }], isError: true };
      }
      const res = await rejectDiscovered(params.slug, params.reason || "user rejected");
      if (!res.ok) {
        return { content: [{ type: "text", text: `Reject failed: ${res.error}` }], details: res, isError: true };
      }
      return { content: [{ type: "text", text: `Rejected ${params.slug}.` }], details: res };
    },
  });

  pi.registerTool({
    name: "list_targets",
    label: "List Targets",
    description: "List the parsed target companies from targets.md grouped by source.",
    parameters: Type.Object({}),
    async execute() {
      const targets = await readTargets();
      const bySource: Record<string, string[]> = {};
      for (const t of targets) {
        (bySource[t.source] ||= []).push(t.slug);
      }
      const lines = Object.entries(bySource).map(([src, slugs]) => `## ${src}\n${slugs.map((s) => `- ${s}`).join("\n")}`);
      return {
        content: [{ type: "text", text: `Targets (${targets.length}):\n${lines.join("\n\n")}` }],
        details: { targets, bySource },
      };
    },
  });

  pi.registerTool({
    name: "add_target",
    label: "Add Target",
    description: "Append a company slug to targets.md under a given source section. Creates the section if missing.",
    parameters: Type.Object({
      company: Type.String({ description: "ATS board slug to add" }),
      source: Type.String({ description: "Source section: 'greenhouse', 'ashby', or 'lever'" }),
    }),
    async execute(_toolCallId, params) {
      const src = params.source.toLowerCase() as "greenhouse" | "ashby" | "lever";
      if (!["greenhouse", "ashby", "lever"].includes(src)) {
        return { content: [{ type: "text", text: `Invalid source '${params.source}'` }], isError: true };
      }
      if (!isSafeSlug(params.company)) {
        return { content: [{ type: "text", text: `unsafe company slug: ${params.company}` }], isError: true };
      }
      const file = wsPath("targets.md");
      const templatePath = wsPath("templates", "targets.template.md");
      await withTargetsLock(async () => {
        let md = await fs.readFile(file, "utf-8").catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
          const template = await fs.readFile(templatePath, "utf-8").catch(() => "# Gather targets\n\n");
          try {
            await atomicCreateFile(file, template, { mode: 0o644 });
          } catch (createErr: any) {
            if (createErr?.code !== "EEXIST") throw createErr;
          }
          return fs.readFile(file, "utf-8");
        });
        const header = `## ${src.charAt(0).toUpperCase() + src.slice(1)}`;
        const sectionRegex = new RegExp(`(^## ${src}\\b.*?$)([\\s\\S]*?)(?=\\n## |$)`, "i");
        if (sectionRegex.test(md)) {
          md = md.replace(sectionRegex, (match, head, body) => {
            if (new RegExp(`^- ${params.company}\\b`, "m").test(body)) return match;
            return `${head}${body.replace(/\s*$/, "")}\n- ${params.company}\n`;
          });
        } else {
          md = md.replace(/\s*$/, "") + `\n\n${header}\n- ${params.company}\n`;
        }
        await atomicWriteFile(file, md);
      });
      return { content: [{ type: "text", text: `Added ${params.company} to ${src} section in targets.md.` }] };
    },
  });

  pi.registerTool({
    name: "gather_status",
    label: "Gather Status",
    description: "Summarize gather_state.json: last gather time, per-company fetch stats, seen-url counts, and current discovered/queue file counts.",
    parameters: Type.Object({}),
    async execute() {
      const gstate = await readGatherState();
      const discovered = (await listDir(wsPath("jobs", "discovered"))).filter((f) => f.endsWith(".md")).length;
      const queued = (await listDir(wsPath("jobs", "queue"))).filter((f) => f.endsWith(".md")).length;
      const seenCount = Object.keys(gstate.seen_urls || {}).length;
      const perCompany = Object.entries(gstate.per_company || {}).map(
        ([c, s]) => `- ${c}: ${s.openings_count} openings, ${s.matched_count} matched${s.error ? `, error: ${s.error}` : ""}`,
      );
      const lines = [
        `Last full gather: ${gstate.last_full_gather || "(never)"}`,
        `Seen URLs: ${seenCount}`,
        `Discovered files: ${discovered}`,
        `Queued files: ${queued}`,
        `Auto-promote: ${gstate.auto_promote}`,
        "",
        "Per-company:",
        ...(perCompany.length ? perCompany : ["(none yet)"]),
      ];
      const rules = await loadFilterRules();
      if (rules.warnings.length > 0) {
        lines.push("", "profile.md:", ...rules.warnings.map((w) => `! ${w}`));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...gstate, discoveredCount: discovered, queuedCount: queued, profileWarnings: rules.warnings },
      };
    },
  });

  pi.registerTool({
    name: "score_discovered",
    label: "Score Discovered Jobs",
    description:
      "Batch-score up to 50 unscored jobs using the configured scoring model. " +
      "Writes llm_score (1-5) and llm_reasoning into each file's frontmatter. " +
      "Already-scored files are skipped. Uses a compact profile summary as the scoring rubric. " +
      "Returns { scored, skipped, errors }.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const summary = await scoreAllDiscovered(signal);
      const lines = [
        `Scoring complete.`,
        `Scored: ${summary.scored}`,
        `Skipped (already scored): ${summary.skipped}`,
        `Errors: ${summary.errors.length}`,
      ];
      if (summary.jobs.length > 0) {
        lines.push("Per-job attempts:");
        for (const entry of summary.jobs) lines.push(`- ${entry.slug}: ${entry.attempts}`);
      }
      if (summary.errors.length > 0) {
        lines.push("Error details:");
        for (const e of summary.errors) lines.push(`- ${e.slug}: ${e.error}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...summary, card: "run-progress" },
      };
    },
  });

  pi.registerTool({
    name: "score_job",
    label: "Score Single Job",
    description:
      "Score a single discovered job by slug using the configured scoring model. Writes llm_score + llm_reasoning into the file's frontmatter. " +
      "Useful for re-scoring after editing a discovered file or when batch scoring fails on one job.",
    parameters: Type.Object({
      slug: Type.String({ description: "Discovered file slug (filename without .md)" }),
    }),
    async execute(_toolCallId, params, signal) {
      if (!isSafeSlug(params.slug)) {
        return { content: [{ type: "text", text: `unsafe slug: ${params.slug}` }], isError: true };
      }
      const dir = wsPath("jobs", "discovered");
      const raw = await fs.readFile(`${dir}/${params.slug}.md`, "utf-8").catch(() => "");
      if (!raw) {
        return { content: [{ type: "text", text: `File not found: ${params.slug}` }], isError: true };
      }
      const fm = parseFrontmatter(raw);
      const scored = await scoreDiscoveredSlug(params.slug, {
        title: fm.title || "",
        company: fm.company || "",
        location: fm.location || "",
        description: raw.split("---").slice(2).join("---").trim(),
        url: fm.url || "",
      }, signal).catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (!scored.ok) {
        return { content: [{ type: "text", text: `Scoring failed: ${scored.error}` }], isError: true };
      }
      return {
        content: [{
          type: "text",
          text: `${params.slug}: score ${scored.result.score}/5 — ${scored.result.reasoning}`,
        }],
        details: scored.result,
      };
    },
  });

  // ── Commands ──

  pi.registerCommand("gather", {
    description: "Discover jobs from all ATS sources in targets.md (filtered + deduped → jobs/discovered/)",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      ctx.ui.notify("Gathering jobs from all sources in targets.md…", "info");
      pi.sendUserMessage("Run a full gather: call the gather_all tool (no source filter) and report the summary, then list what landed in jobs/discovered/.", {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand("gather-greenhouse", {
    description: "Gather from a single Greenhouse board (pass the board slug as an arg)",
    handler: async (args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      const slug = (args || "").trim();
      if (!slug) {
        ctx.ui.notify("Usage: /gather-greenhouse <board-slug> (e.g. /gather-greenhouse figma)", "warning");
        return;
      }
      ctx.ui.notify(`Gathering from Greenhouse board '${slug}'…`, "info");
      pi.sendUserMessage(`Gather from a single Greenhouse board: call gather_all with singleGreenhouse="${slug}" and report the summary.`, {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand("review-discovered", {
    description: "List jobs in jobs/discovered/ with match strength, ready to promote or reject",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      const items = await listDiscovered();
      if (items.length === 0) {
        ctx.ui.notify("No discovered jobs to review. Run /gather first.", "info");
        return;
      }
      ctx.ui.notify(`Discovered: ${items.length}. Review and promote/reject as needed.`, "info");
      const reviewLines = items.map((i) => {
        const scoreTag = i.llm_score ? ` [LLM: ${i.llm_score}/5]` : "";
        const reasoning = i.llm_reasoning ? ` — ${i.llm_reasoning}` : "";
        return `- [${i.match}]${scoreTag} ${i.slug} — ${i.company} / ${i.title} / ${i.location}${reasoning}`;
      });
      pi.sendUserMessage(
        `Review the discovered jobs. Present them sorted by LLM score (highest first), then by match strength. ` +
        `Offer to promote scores 4-5 to jobs/queue/ via promote_to_queue, or reject via reject_discovered. ` +
        `If any files lack an LLM score, suggest running /score-discovered first. Here is the current list:\n${reviewLines.join("\n")}`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("score-discovered", {
    description: "Score up to 50 unscored discovered jobs using the configured model",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      ctx.ui.notify("Scoring discovered jobs with the configured model…", "info");
      const dashboardRun = Boolean(process.env.PI_JOBS_RUN_ID?.trim());
      if (!dashboardRun) {
        pi.sendUserMessage(
          "Run the score_discovered tool to batch-score unscored jobs using the configured scoring model. " +
          "Then report the results and run /review-discovered to show the updated rankings.",
          { deliverAs: "followUp" },
        );
        return;
      }
      const parts: AbortSignal[] = [];
      if (ctx.signal) parts.push(ctx.signal);
      const signal = parts.length > 0 ? AbortSignal.any(parts) : undefined;
      const summary = await scoreAllDiscovered(signal);
      const lines = [
        "Scoring complete.",
        `Scored: ${summary.scored}`,
        `Skipped (already scored): ${summary.skipped}`,
        `Errors: ${summary.errors.length}`,
      ];
      if (summary.jobs.length > 0) {
        lines.push("Per-job attempts:");
        for (const entry of summary.jobs) lines.push(`- ${entry.slug}: ${entry.attempts}`);
      }
      if (summary.errors.length > 0) {
        lines.push("Error details:");
        for (const e of summary.errors) lines.push(`- ${e.slug}: ${e.error}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("targets", {
    description: "Show the current target company list from targets.md",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      const targets = await readTargets();
      const bySource: Record<string, string[]> = {};
      for (const t of targets) (bySource[t.source] ||= []).push(t.slug);
      const msg = Object.entries(bySource)
        .map(([src, slugs]) => `${src}: ${slugs.join(", ")}`)
        .join(" | ");
      ctx.ui.notify(`Targets: ${msg}`, "info");
    },
  });

  pi.registerCommand("gather-status", {
    description: "Show gather_state.json summary (last gather, seen URLs, per-company stats)",
    handler: async (_args, ctx) => {
      if (!isInWorkspace(ctx.cwd)) {
        ctx.ui.notify("Job gatherer extension is only active in the workspace root.", "warning");
        return;
      }
      ctx.ui.notify("Gather status — see details below.", "info");
      pi.sendUserMessage("Show the current gather status by calling the gather_status tool and summarizing it.", {
        deliverAs: "followUp",
      });
    },
  });

  // ── Session start notification ──
  pi.on("session_start", async (_event, ctx) => {
    if (isInWorkspace(ctx.cwd)) {
      ctx.ui.notify(
        "Job Gatherer loaded. Use /gather, /gather-greenhouse <slug>, /score-discovered, /review-discovered, /targets, or /gather-status.",
        "info",
      );
    }
  });
}

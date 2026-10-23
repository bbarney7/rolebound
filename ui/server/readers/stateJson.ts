import { paths, toIsoOrNull } from "../workspace";
import { readJsonFile } from "../../../.pi/extensions/lib/durable-store";
import { parseStateText } from "../../../.pi/extensions/lib/workspace-files";
import {
  APPLY_STATES,
  type Address,
  type Application,
  type ApplyState,
  type RawApplication,
  type RawStateJson,
} from "../../shared/types";

export interface StateData {
  /** raw entries — normalized via normalizeStateApplication (union does this) */
  applications: RawApplication[];
  addresses: Address[];
  lastUpdated: string | null;
}

export async function readState(root: string): Promise<StateData> {
  const read = await readJsonFile(paths.stateJson(root), parseStateText);
  if (read.state === "missing") {
    return { applications: [], addresses: [], lastUpdated: null };
  }
  const raw = read.value as RawStateJson;
  const addresses: Address[] = Object.entries(raw.addresses ?? {}).map(([cityKey, a]) => {
    const entry = (a ?? {}) as Record<string, string | undefined>;
    return {
      cityKey,
      street: entry.street ?? "",
      city: entry.city ?? "",
      state: entry.state ?? "",
      zip: entry.zip ?? "",
    };
  });
  return {
    applications: (raw.applications ?? []) as RawApplication[],
    addresses,
    lastUpdated: toIsoOrNull(raw.last_updated ?? null),
  };
}

export function normalizeApplyState(status: string | null | undefined): ApplyState {
  return (APPLY_STATES as readonly string[]).includes(status ?? "")
    ? (status as ApplyState)
    : "queued";
}

export function inferSourceFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host.includes("greenhouse")) return "greenhouse";
    if (host.includes("ashbyhq")) return "ashby";
    if (host.includes("lever.co")) return "lever";
    if (host.includes("myworkdayjobs")) return "workday";
    if (host.includes("icims")) return "icims";
    if (host.includes("jobvite")) return "jobvite";
    if (host.includes("oraclecloud")) return "oraclecloud";
    if (host.includes("linkedin")) return "LinkedIn";
    return host;
  } catch {
    return null;
  }
}

/** Normalize a state.json application entry. ui-state overlay happens in the union. */
export function normalizeStateApplication(
  raw: RawApplication,
  stateLastUpdated: string | null,
): Application {
  return {
    slug: raw.slug ?? "unknown",
    url: raw.url ?? null,
    company: raw.company ?? null,
    title: raw.title ?? null,
    location: raw.location_raw ?? null,
    source: inferSourceFromUrl(raw.url ?? null),
    applyState: normalizeApplyState(raw.status),
    pipelineStatus: null,
    pipelineExplicit: false,
    submittedAt: toIsoOrNull(raw.submitted_at),
    estimated: false,
    resumePath: raw.resume ?? null,
    resumeKey: raw.resume_key ?? null,
    addressCityKey: raw.address_city_key ?? null,
    addressUsed: raw.address
      ? {
          street: raw.address.street ?? "",
          city: raw.address.city ?? "",
          state: raw.address.state ?? "",
          zip: raw.address.zip ?? "",
        }
      : null,
    attempts: (raw.attempts ?? []).map((a) => ({
      startedAt: a.started_at ?? "",
      endedAt: a.ended_at ?? null,
      outcome: a.outcome ?? null,
      notes: a.notes ?? null,
    })),
    screenshot: raw.screenshot ?? null,
    verificationEmailId: raw.verification_email_id ?? null,
    abortReason: raw.abort_reason ?? null,
    blockReason: raw.block_reason ?? null,
    jobFilePath: null,
    descriptionExcerpt: null,
    queueFile: raw.queue_file ?? null,
    userNotes: null,
    lastUpdated: stateLastUpdated,
  };
}

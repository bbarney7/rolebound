import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { atomicWriteFile, NO_CHANGE, withFileLock, type LockContext } from "./durable-store";
import { workspaceFilePath } from "./workspace-files";

export type InstructionSectionKey = "applying" | "finding" | "chat";

export type InstructionsSections = Record<InstructionSectionKey, string>;

const SECTION_HEADINGS: Record<InstructionSectionKey, string> = {
  applying: "Applying",
  finding: "Finding and scoring",
  chat: "Chat",
};

const HEADING_TO_KEY = new Map(
  Object.entries(SECTION_HEADINGS).map(([key, heading]) => [normalizeHeading(heading), key as InstructionSectionKey]),
);

const CANONICAL_ORDER: InstructionSectionKey[] = ["applying", "finding", "chat"];

export type InstructionPart =
  | { kind: "raw"; text: string }
  | { kind: "section"; key: InstructionSectionKey; body: string };

function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase();
}

export function parseInstructionsDocument(text: string): InstructionPart[] {
  if (text === "") return [];
  const parts: InstructionPart[] = [];
  const lines = text.split("\n");
  let i = 0;
  let rawBuf = "";

  const flushRaw = () => {
    if (rawBuf !== "") {
      parts.push({ kind: "raw", text: rawBuf });
      rawBuf = "";
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (!match) {
      rawBuf += `${line}\n`;
      i += 1;
      continue;
    }
    flushRaw();
    const heading = match[1];
    const key = HEADING_TO_KEY.get(normalizeHeading(heading));
    i += 1;
    let body = "";
    while (i < lines.length && !/^##\s+/.test(lines[i])) {
      body += `${lines[i]}\n`;
      i += 1;
    }
    if (key) {
      parts.push({ kind: "section", key, body: body.replace(/^\n+/, "").replace(/\n+$/, "") });
    } else {
      rawBuf = `## ${heading}\n${body}`;
    }
  }
  flushRaw();
  return parts;
}

function serializeParts(parts: InstructionPart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.kind === "raw") {
      chunks.push(part.text.replace(/\n$/, ""));
      continue;
    }
    const body = part.body.trimEnd();
    chunks.push(`## ${SECTION_HEADINGS[part.key]}\n\n${body}${body ? "\n" : ""}`);
  }
  const joined = chunks.filter((c) => c !== "").join("\n\n");
  return joined === "" ? "" : `${joined}\n`;
}

function sectionsFromParts(parts: InstructionPart[]): InstructionsSections {
  const out: InstructionsSections = { applying: "", finding: "", chat: "" };
  for (const part of parts) {
    if (part.kind === "section") out[part.key] = part.body;
  }
  return out;
}

function findInsertIndex(parts: InstructionPart[], key: InstructionSectionKey): number {
  const rank = CANONICAL_ORDER.indexOf(key);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.kind !== "section") continue;
    if (CANONICAL_ORDER.indexOf(part.key) > rank) return i;
  }
  return parts.length;
}

function applySectionBodies(
  parts: InstructionPart[],
  bodies: Partial<InstructionsSections>,
): InstructionPart[] {
  const out: InstructionPart[] = [];
  const seen = new Set<InstructionSectionKey>();
  for (const part of parts) {
    if (part.kind === "section" && bodies[part.key] !== undefined) {
      out.push({ kind: "section", key: part.key, body: bodies[part.key]! });
      seen.add(part.key);
      continue;
    }
    out.push(part);
  }
  for (const key of CANONICAL_ORDER) {
    if (bodies[key] === undefined || seen.has(key)) continue;
    out.splice(findInsertIndex(out, key), 0, { kind: "section", key, body: bodies[key]! });
  }
  return out;
}

export function revisionForInstructionsText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readInstructionsText(root: string): Promise<string | null> {
  const file = workspaceFilePath(root, "instructions");
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

async function ensureInstructionsFile(file: string): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, "", "utf8");
  }
}

async function mutateInstructionsFile(
  root: string,
  mutate: (text: string) => string | typeof NO_CHANGE,
  expectedRevision?: string | null,
): Promise<{ text: string; revision: string }> {
  const file = workspaceFilePath(root, "instructions");
  await ensureInstructionsFile(file);
  return withFileLock(file, async (ctx: LockContext) => {
    const before = await fs.readFile(file, "utf8");
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (revisionForInstructionsText(before) !== expectedRevision) {
        throw Object.assign(new Error("instructions changed; reload and retry"), { code: "REVISION_CONFLICT" });
      }
    } else if (expectedRevision === null && before !== "") {
      throw Object.assign(new Error("instructions changed; reload and retry"), { code: "REVISION_CONFLICT" });
    }
    const next = mutate(before);
    if (next === NO_CHANGE) {
      return { text: before, revision: revisionForInstructionsText(before) };
    }
    await atomicWriteFile(file, next, { lockCtx: ctx });
    return { text: next, revision: revisionForInstructionsText(next) };
  });
}

export async function readInstructions(root: string): Promise<InstructionsSections> {
  const text = await readInstructionsText(root);
  if (text === null) return { applying: "", finding: "", chat: "" };
  return sectionsFromParts(parseInstructionsDocument(text));
}

export async function readInstructionsEnvelope(
  root: string,
): Promise<{ data: InstructionsSections; revision: string | null }> {
  const text = await readInstructionsText(root);
  if (text === null) {
    return { data: { applying: "", finding: "", chat: "" }, revision: null };
  }
  return {
    data: sectionsFromParts(parseInstructionsDocument(text)),
    revision: revisionForInstructionsText(text),
  };
}

export async function writeInstructions(root: string, all: InstructionsSections, expectedRevision?: string | null) {
  // Merge against the text read under the lock, so a concurrent chat edit is never overwritten.
  return mutateInstructionsFile(root, (before) => serializeParts(applySectionBodies(parseInstructionsDocument(before), all)), expectedRevision);
}

export async function writeInstructionSection(
  root: string,
  section: InstructionSectionKey,
  markdown: string,
  mode: "replace" | "append" = "append",
): Promise<InstructionsSections> {
  const { text } = await mutateInstructionsFile(root, (before) => {
    const parts = parseInstructionsDocument(before);
    const prior = sectionsFromParts(parts)[section];
    const body =
      mode === "replace"
        ? markdown
        : prior.trim() === ""
          ? markdown
          : `${prior.trimEnd()}\n\n${markdown.trim()}`;
    return serializeParts(applySectionBodies(parts, { [section]: body }));
  });
  return sectionsFromParts(parseInstructionsDocument(text));
}

export function formatApplyingInstructionsBlock(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `\n\n## Standing instructions from the user\nFollow these on every application. Where they conflict with the defaults above, these win.\n\n${trimmed}`;
}

export function formatFindingInstructionsBlock(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `\n\n## Standing instructions from the user\nFollow these when discovering and scoring jobs. Where they conflict with the defaults above, these win.\n\n${trimmed}`;
}

export function formatChatInstructionsBlock(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `\n\n## Standing instructions from the user\nFollow these in this chat. Where they conflict with the defaults above, these win.\n\n${trimmed}`;
}

export function formatChatReferenceInstructions(sections: InstructionsSections): string {
  const chunks: string[] = [];
  if (sections.applying.trim()) {
    chunks.push(
      `### Reference: application rules\n${sections.applying.trim()}`,
    );
  }
  if (sections.finding.trim()) {
    chunks.push(
      `### Reference: finding and scoring rules\n${sections.finding.trim()}`,
    );
  }
  if (chunks.length === 0) return "";
  return `\n\n## Your saved agent instructions (reference)\n${chunks.join("\n\n")}`;
}

export const MAX_INSTRUCTION_SECTION_LENGTH = 20_000;

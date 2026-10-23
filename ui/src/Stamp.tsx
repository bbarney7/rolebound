import type { ReactNode } from "react";
import { APPLY_STATES, type ApplyState, type PipelineStatus } from "../shared/types";

/**
 * A status is a mono uppercase word with a glyph in front of it. The tone
 * picks both the colour pair and the glyph shape (index.css `.stamp.<tone>`):
 * filled square, triangle, circle, rotated square, hollow square. Two stamps
 * therefore stay distinguishable with colour removed — the text and the shape
 * carry the state, colour only reinforces it. This component sets the class;
 * the glyph is CSS.
 */
export type Tone = "good" | "warn" | "crit" | "neutral" | "accent";

/** The same tones as CSS custom properties, for the two data-driven inline styles. */
export const TONE_VAR: Record<Tone, string> = {
  good: "var(--good)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  crit: "var(--crit)",
  neutral: "var(--line-strong)",
};

export function applyStateTone(state: ApplyState): Tone {
  switch (state) {
    case "submitted":
      return "good";
    case "in_progress":
    case "queued":
      return "accent";
    case "paused_for_user":
      return "warn";
    case "blocked":
    case "failed":
      return "crit";
    case "aborted":
      return "neutral";
  }
}

export function pipelineTone(status: PipelineStatus): Tone {
  switch (status) {
    case "submitted":
    case "offer":
      return "good";
    case "interviewing":
      return "warn";
    case "rejected":
    case "withdrawn":
    case "no_response":
      return "neutral";
  }
}

/** `Attempt.outcome` is a free string in the state contract; only known apply states get a stamp. */
export function isApplyState(value: string | null): value is ApplyState {
  return value !== null && (APPLY_STATES as readonly string[]).includes(value);
}

export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

export default function Stamp({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`stamp ${tone}`}>{children}</span>;
}

import type { ConnectionList } from "../../shared/providers";
import type { RunSummary } from "../../shared/types";
import type { RunEntry } from "../useRun";
import {
  buildChatModelSwitchNote,
  chatRunEligibleForContinue,
  effectiveChatSelection,
  selectionKey,
  shortModelLabel,
} from "./modelSelection";

export interface ChatModelSwitchPlan {
  continueFrom: string | null;
  note: string | null;
  finishFirst: boolean;
}

export function planChatModelSwitch(
  prev: ConnectionList | null,
  next: ConnectionList,
  run: RunSummary | null,
  entries: RunEntry[],
  history: RunEntry[],
): ChatModelSwitchPlan {
  const prevEffective = effectiveChatSelection(prev?.data.chat, prev?.data.agent);
  const nextEffective = effectiveChatSelection(next.data.chat, next.data.agent);
  if (selectionKey(prevEffective) === selectionKey(nextEffective)) {
    return { continueFrom: null, note: null, finishFirst: false };
  }

  const hasTranscript = entries.length > 0 || history.length > 0;
  if (!chatRunEligibleForContinue(run, hasTranscript) || !run) {
    return { continueFrom: null, note: null, finishFirst: false };
  }

  const modelLabel = nextEffective ? shortModelLabel(nextEffective) : "model";

  return {
    continueFrom: run.runId,
    note: buildChatModelSwitchNote(modelLabel),
    finishFirst: run.status === "waiting",
  };
}

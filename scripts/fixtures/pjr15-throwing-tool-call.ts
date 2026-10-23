import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** PJR-15 submission-smoke scenario (8): pi fail-safe when a tool_call handler throws. */
export default function pjr15ThrowingToolCall(pi: ExtensionAPI) {
  if (process.env.PJR15_THROWING_GUARD !== "1") return;
  pi.on("tool_call", async (event) => {
    if (event.toolName.includes("browser_click")) {
      throw new Error("pjr15 throwing tool_call handler");
    }
  });
}

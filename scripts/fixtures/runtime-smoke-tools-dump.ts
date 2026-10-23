import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

export default function runtimeSmokeToolsDump(pi: ExtensionAPI) {
  let wrote = false;
  const dump = () => {
    if (wrote) return;
    wrote = true;
    const out = process.env.RUNTIME_SMOKE_TOOLS_OUT;
    if (!out) return;
    const tools = pi.getAllTools().map((t) => t.name);
    writeFileSync(out, `${JSON.stringify(tools)}\n`);
  };
  pi.on("agent_settled", async () => {
    dump();
  });
  pi.on("session_shutdown", async () => {
    dump();
  });
}

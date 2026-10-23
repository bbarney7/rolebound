import { spawn } from "node:child_process";

/** Own one child until stdio closes; signal delivery alone is not completion. */
export function runChild(command, args, {
  cwd, env = process.env, stdio = "inherit", signals = process,
  shutdownMs = 15_000, reapMs = 2000, onChild,
} = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio });
    let requestedSignal = null;
    let forced = false;
    let error = null;
    let settled = false;
    let timer;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signals.off("SIGINT", onInt);
      signals.off("SIGTERM", onTerm);
      resolve({ code, signal, requestedSignal, forced, error });
    };
    const stop = signal => {
      if (settled || requestedSignal) return;
      requestedSignal = signal;
      child.kill(signal);
      timer = setTimeout(() => {
        forced = true;
        child.kill("SIGKILL");
        timer = setTimeout(() => {
          error = new Error("owned child did not close after SIGKILL");
          finish(null, "SIGKILL");
        }, reapMs);
      }, shutdownMs);
    };
    const onInt = () => stop("SIGINT");
    const onTerm = () => stop("SIGTERM");
    signals.on("SIGINT", onInt);
    signals.on("SIGTERM", onTerm);
    child.on("error", err => { error = err; });
    child.once("close", finish);
    onChild?.(child);
  });
}

/** Only a clean normal exit proves production cleanup completed. */
export function childExitCode(result) {
  if (result.error || result.forced) return 1;
  if (result.code !== null) return result.code;
  return 1;
}

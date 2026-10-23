import { Router } from "express";
import { listApplications } from "../union";
import { listJobFiles } from "../readers/jobFiles";
import { readAccounts } from "../readers/credentials";
import { readState } from "../readers/stateJson";
import { readGatherStateSummary } from "../readers/gatherState";
import { readSettingsFile } from "../settingsStore";
import { resolveCaptchaSettings, SettingsShapeError } from "../../../.pi/extensions/lib/captcha";
import { WorkspaceFileError } from "../../../.pi/extensions/lib/durable-store";
import { inspectCaptchaSpendFile } from "../../../.pi/extensions/lib/captcha-spend";
import { CredentialsShapeError } from "../readers/credentials";
import type { CorruptWorkspaceFile, Overview } from "../../shared/types";

function isCorruptFileError(err: unknown, file: CorruptWorkspaceFile): boolean {
  return err instanceof WorkspaceFileError && err.code === "CORRUPT" && err.file.endsWith(file);
}

/**
 * `env` is the same seam the settings routes resolve against, so the overview
 * and the Settings view can never disagree about the effective solver; a test
 * passes `{}`.
 */
export function overviewRouter(root: string, env: NodeJS.ProcessEnv = process.env): Router {
  const router = Router();
  router.get("/", async (_req, res, next) => {
    try {
      const corrupt: CorruptWorkspaceFile[] = [];

      let apps = null as Awaited<ReturnType<typeof listApplications>> | null;
      try {
        apps = await listApplications(root);
      } catch (err) {
        if (isCorruptFileError(err, "state.json")) corrupt.push("state.json");
        else throw err;
      }

      const [queue, discovered] = await Promise.all([
        listJobFiles(root, "queue"),
        listJobFiles(root, "discovered"),
      ]);

      let accounts: Awaited<ReturnType<typeof readAccounts>> | null = null;
      try {
        accounts = await readAccounts(root);
      } catch (err) {
        if (
          isCorruptFileError(err, "credentials.json") ||
          err instanceof CredentialsShapeError ||
          err instanceof SyntaxError
        ) {
          corrupt.push("credentials.json");
        } else throw err;
      }

      let state: Awaited<ReturnType<typeof readState>> | null = null;
      try {
        state = await readState(root);
      } catch (err) {
        if (isCorruptFileError(err, "state.json")) {
          if (!corrupt.includes("state.json")) corrupt.push("state.json");
        } else throw err;
      }

      let gather: Awaited<ReturnType<typeof readGatherStateSummary>>;
      try {
        gather = await readGatherStateSummary(root);
        if (gather.status === "corrupt") {
          corrupt.push("gather_state.json");
        }
      } catch (err) {
        if (isCorruptFileError(err, "gather_state.json")) {
          corrupt.push("gather_state.json");
          gather = {
            seenUrlCount: 0,
            perCompanyCount: 0,
            lastFullGather: null,
            autoPromote: false,
            status: "corrupt",
          };
        } else throw err;
      }

      try {
        await inspectCaptchaSpendFile(root);
      } catch (err) {
        if (err instanceof WorkspaceFileError && err.code === "CORRUPT") {
          corrupt.push(".pi-jobs/captcha-spend.json");
        } else {
          throw err;
        }
      }

      const settings = await readSettingsFile(root).catch((err: unknown) => {
        if (err instanceof SyntaxError || err instanceof SettingsShapeError) {
          return { raw: {}, captcha: { provider: "off" as const, api_key: "" }, warnings: [] };
        }
        throw err;
      });

      const byApplyState: Record<string, number> = {};
      const byPipelineStatus: Record<string, number> = {};
      let tracked = 0;
      let estimated = 0;
      if (apps) {
        for (const a of apps) {
          byApplyState[a.applyState] = (byApplyState[a.applyState] ?? 0) + 1;
          const p = a.pipelineStatus ?? "none";
          byPipelineStatus[p] = (byPipelineStatus[p] ?? 0) + 1;
          if (a.estimated) estimated++;
          else tracked++;
        }
      }

      const overview: Overview = {
        applications: apps
          ? {
              total: apps.length,
              tracked,
              estimated,
              byApplyState,
              byPipelineStatus,
            }
          : null,
        queue: queue.length,
        discovered: discovered.length,
        accounts: accounts ? accounts.length : null,
        addresses: state ? state.addresses.length : null,
        lastFullGather: gather.lastFullGather,
        captchaSolver: (() => {
          const resolved = resolveCaptchaSettings(settings.captcha, env);
          return resolved.apiKey === "" ? "off" : resolved.provider;
        })(),
        corrupt,
      };
      res.json(overview);
    } catch (err) {
      next(err);
    }
  });
  return router;
}

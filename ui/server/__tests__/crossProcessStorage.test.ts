import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileWorkspace } from "../../../.pi/extensions/lib/reconcile";
import { LOCK_STALE_MS } from "../../../.pi/extensions/lib/durable-store";
import { createAccountEntry, deleteAccountEntry, updateAccountEntry } from "../accountsWriter";
import { markSeenUrlPromoted } from "../readers/gatherState";
import { promoteQueueFile } from "../queueWriter";
import { recordSupervisedAcknowledgement } from "../readiness";
import { createExtensionHarnessWorkspace, credentialsPath, minimalProfileMd } from "./extensionHarness";
import {
  assertWorkspaceStoresHealthy,
  killAndDrain,
  spawnCrossProcessChild,
  waitForPause,
  waitUntilLockable,
  writeStateAddress,
} from "./crossProcessHelpers";
import { createBackup, initWorkspace, restoreBackup, sha256File } from "../../../scripts/workspace.mjs";

describe("crossProcessStorage", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function freshWorkspace() {
    const ws = await createExtensionHarnessWorkspace();
    cleanups.push(ws.cleanup);
    await fs.writeFile(path.join(ws.root, "profile.md"), minimalProfileMd(), "utf8");
    await fs.writeFile(credentialsPath(ws.root), "{}", "utf8");
    await fs.writeFile(
      path.join(ws.root, "gather_state.json"),
      JSON.stringify({ seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(ws.root, "state.json"),
      JSON.stringify({ applications: [], addresses: {} }, null, 2),
      "utf8",
    );
    return ws;
  }

  it(
    "a) concurrent extension/server credential creates then update/delete race",
    async () => {
      const ws = await freshWorkspace();
      const hostsA = Array.from({ length: 25 }, (_, i) => `a${i + 1}.example.com`);
      const hostsB = Array.from({ length: 25 }, (_, i) => `b${i + 1}.example.com`);

      const extCreates = await Promise.all(
        hostsA.map((host) =>
          spawnCrossProcessChild(ws.root, { op: "create_account", host, company: `Co ${host}`, ats: "other" }),
        ),
      );
      const srvCreates = hostsB.map((host) =>
        createAccountEntry(ws.root, host, { username: "srv", ats: "other", company: `Co ${host}` }),
      );
      await Promise.all([
        ...extCreates.map((c) => c.wait()),
        ...srvCreates,
      ]);

      const extUpdates = await Promise.all(
        hostsA.slice(0, 10).map((host) =>
          spawnCrossProcessChild(ws.root, { op: "update_account", host, notes: "cross-updated" }),
        ),
      );
      const srvDeletes = hostsB.slice(0, 10).map((host) => deleteAccountEntry(ws.root, host));
      await Promise.all([...extUpdates.map((c) => c.wait()), ...srvDeletes]);

      const raw = JSON.parse(await fs.readFile(credentialsPath(ws.root), "utf8")) as Record<
        string,
        { notes?: string; username?: string }
      >;
      for (const host of hostsA) {
        expect(raw[host]).toBeDefined();
        if (hostsA.indexOf(host) < 10) {
          expect(raw[host].notes).toContain("cross-updated");
        }
      }
      for (const host of hostsB.slice(10)) {
        expect(raw[host]).toBeDefined();
      }
      for (const host of hostsB.slice(0, 10)) {
        expect(raw[host]).toBeUndefined();
      }
      await assertWorkspaceStoresHealthy(ws.root);
    },
    60_000,
  );

  it(
    "b) extension application state races server address PUT and acknowledgement",
    async () => {
      const ws = await freshWorkspace();
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug: "role-b", status: "in_progress" }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );

      const childState = await spawnCrossProcessChild(ws.root, {
        op: "update_application_state",
        params: { slug: "role-b", status: "blocked", block_reason: "test" },
      });
      const childAddr = await spawnCrossProcessChild(ws.root, {
        op: "generate_address",
        params: {
          city_key: "denver",
          address: { street: "1 Main", city: "Denver", state: "CO", zip: "80202" },
        },
      });
      const serverWrites = Promise.all([
        writeStateAddress(ws.root, "portland", {
          street: "2 Oak",
          city: "Portland",
          state: "OR",
          zip: "97201",
        }),
        recordSupervisedAcknowledgement(ws.root),
      ]);
      await Promise.all([childState.wait(), childAddr.wait(), serverWrites]);

      const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
      expect(state.acknowledged_at).toBeTruthy();
      expect(state.addresses.denver).toEqual({
        street: "1 Main",
        city: "Denver",
        state: "CO",
        zip: "80202",
      });
      expect(state.addresses.portland).toEqual({
        street: "2 Oak",
        city: "Portland",
        state: "OR",
        zip: "97201",
      });
      const app = state.applications.find((a: { slug: string }) => a.slug === "role-b");
      expect(app?.status).toBe("blocked");
      await assertWorkspaceStoresHealthy(ws.root);
    },
    30_000,
  );

  it(
    "c) gather merge, server promote, and extension reject keep every decision",
    async () => {
      const ws = await freshWorkspace();
      const urlMerge = "https://race.example/merge";
      const urlPromote = "https://race.example/promote";
      const urlReject = "https://race.example/reject";
      const slugReject = "reject-me";
      const slugPromote = "promote-me";

      await fs.writeFile(
        path.join(ws.root, "gather_state.json"),
        JSON.stringify(
          {
            seen_urls: {
              [urlMerge]: { decision: "discovered", company: "M", title: "T", source: "t" },
              [urlPromote]: { decision: "discovered", company: "P", title: "T", source: "t" },
              [urlReject]: { decision: "discovered", company: "R", title: "T", source: "t" },
            },
            per_company: {},
            last_full_gather: null,
            auto_promote: false,
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        path.join(ws.root, "jobs", "discovered", `${slugReject}.md`),
        `url: ${urlReject}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(ws.root, "jobs", "discovered", `${slugPromote}.md`),
        `url: ${urlPromote}\n`,
        "utf8",
      );

      const snapshot = {
        [urlMerge]: { decision: "discovered", company: "M", title: "T", source: "t" },
        [urlPromote]: { decision: "discovered", company: "P", title: "T", source: "t" },
        [urlReject]: { decision: "discovered", company: "R", title: "T", source: "t" },
      };
      const proposed = {
        seen_urls: {
          [urlMerge]: { decision: "discovered", company: "M", title: "Merged", source: "gather" },
        },
        per_company: { acme: { last_fetched: "t" } },
        last_full_gather: "2026-01-01T00:00:00.000Z",
        auto_promote: false,
      };

      const mergeChild = await spawnCrossProcessChild(ws.root, {
        op: "gather_merge",
        snapshot,
        proposed,
        companies: ["acme"],
      });
      const promoteSrv = markSeenUrlPromoted(ws.root, urlPromote, {
        company: "P",
        title: "T",
        source: "server",
      });
      const rejectChild = await spawnCrossProcessChild(ws.root, {
        op: "reject_discovered",
        slug: slugReject,
        reason: "cross reject",
      });
      await Promise.all([mergeChild.wait(), promoteSrv, rejectChild.wait()]);

      const gather = JSON.parse(await fs.readFile(path.join(ws.root, "gather_state.json"), "utf8"));
      expect(gather.seen_urls[urlPromote].decision).toBe("promoted");
      expect(gather.seen_urls[urlReject].decision).toBe("rejected");
      expect(gather.seen_urls[urlMerge].title).toBe("Merged");
      expect(gather.per_company.acme).toBeDefined();
      await expect(fs.access(path.join(ws.root, "jobs", "discovered", `${slugReject}.md`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await assertWorkspaceStoresHealthy(ws.root);
    },
    30_000,
  );

  it(
    "d) SIGKILL on state.json lock holder yields stale recovery without truncation",
    async () => {
      const ws = await freshWorkspace();
      const statePath = path.join(ws.root, "state.json");
      const before = await fs.readFile(statePath, "utf8");

      const holder = await spawnCrossProcessChild(ws.root, {
        op: "hold_state_lock",
        pauseToken: "state-lock",
      });
      await waitForPause(ws.root, "state-lock");

      const child = holder.child;
      child.kill("SIGKILL");
      await holder.wait();

      await waitUntilLockable(statePath, LOCK_STALE_MS + 5_000);

      await writeStateAddress(ws.root, "austin", {
        street: "9 Elm",
        city: "Austin",
        state: "TX",
        zip: "78701",
      });

      const after = await fs.readFile(statePath, "utf8");
      expect(after.length).toBeGreaterThan(0);
      const parsed = JSON.parse(after);
      const hasNew = parsed.addresses?.austin !== undefined;
      const unchanged = after === before;
      expect(hasNew || unchanged).toBe(true);
      if (!hasNew) expect(after).toBe(before);
      await assertWorkspaceStoresHealthy(ws.root);
    },
    35_000,
  );

  describe("e) SIGKILL at each primitive pause then reconcile", () => {
    async function reconcileAll(root: string) {
      await reconcileWorkspace(root, { apply: true });
      await assertWorkspaceStoresHealthy(root);
    }

    it("promote paused between link and unlink", async () => {
      const ws = await freshWorkspace();
      const url = "https://pause.example/promote";
      const slug = "pause-promote";
      await fs.writeFile(path.join(ws.root, "jobs", "discovered", `${slug}.md`), `url: ${url}\n`, "utf8");
      const child = await spawnCrossProcessChild(ws.root, {
        op: "promote_discovered",
        slug,
        pause: "afterLink",
        pauseToken: "promote-link",
      });
      await waitForPause(ws.root, "promote-link");
      await killAndDrain(child);
      await reconcileAll(ws.root);
      const gather = JSON.parse(await fs.readFile(path.join(ws.root, "gather_state.json"), "utf8"));
      expect(gather.seen_urls[url]?.decision).toBe("promoted");
    }, 30_000);

    it("reject paused between upsert and unlink", async () => {
      const ws = await freshWorkspace();
      const url = "https://pause.example/reject";
      const slug = "pause-reject";
      await fs.writeFile(
        path.join(ws.root, "gather_state.json"),
        JSON.stringify({ seen_urls: {}, per_company: {}, last_full_gather: null, auto_promote: false }, null, 2),
        "utf8",
      );
      await fs.writeFile(path.join(ws.root, "jobs", "discovered", `${slug}.md`), `url: ${url}\n`, "utf8");
      const child = await spawnCrossProcessChild(ws.root, {
        op: "reject_discovered",
        slug,
        reason: "paused",
        pause: "afterRejectPending",
        pauseToken: "reject-upsert",
      });
      await waitForPause(ws.root, "reject-upsert");
      await killAndDrain(child);
      await reconcileAll(ws.root);
      const gather = JSON.parse(await fs.readFile(path.join(ws.root, "gather_state.json"), "utf8"));
      expect(["rejected", "discovered"]).toContain(gather.seen_urls[url]?.decision);
    }, 45_000);

    it("completion paused between link and unlink for 0-<slug>.md source", async () => {
      const ws = await freshWorkspace();
      const slug = "zero-src";
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug, status: "submitted", queue_file: `jobs/queue/0-${slug}.md` }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(path.join(ws.root, "jobs", "queue", `0-${slug}.md`), "url: https://pause.example/z\n", "utf8");
      const child = await spawnCrossProcessChild(ws.root, {
        op: "complete_application",
        slug,
        pause: "afterLink",
        pauseToken: "complete-link",
      });
      await waitForPause(ws.root, "complete-link");
      await killAndDrain(child);
      await reconcileAll(ws.root);
      const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
      const app = state.applications.find((a: { slug: string }) => a.slug === slug);
      expect(app?.queue_file).toBe(`jobs/applied/${slug}.md`);
      await expect(fs.access(path.join(ws.root, "jobs", "applied", `${slug}.md`))).resolves.toBeUndefined();
    }, 30_000);

    it("completion paused between move and repoint", async () => {
      const ws = await freshWorkspace();
      const slug = "repoint";
      await fs.writeFile(
        path.join(ws.root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug, status: "submitted", queue_file: `jobs/queue/${slug}.md` }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(path.join(ws.root, "jobs", "queue", `${slug}.md`), "url: https://pause.example/r\n", "utf8");
      const child = await spawnCrossProcessChild(ws.root, {
        op: "complete_application",
        slug,
        pause: "afterMoveBeforeRepoint",
        pauseToken: "complete-repoint",
      });
      await waitForPause(ws.root, "complete-repoint");
      await killAndDrain(child);
      await reconcileAll(ws.root);
      const state = JSON.parse(await fs.readFile(path.join(ws.root, "state.json"), "utf8"));
      const app = state.applications.find((a: { slug: string }) => a.slug === slug);
      expect(app?.queue_file).toBe(`jobs/applied/${slug}.md`);
    }, 30_000);

    it("gather paused between discovered writes and merge", async () => {
      const ws = await freshWorkspace();
      const url = "https://pause.example/gather";
      await fs.writeFile(path.join(ws.root, "jobs", "discovered", "gather-pause.md"), `url: ${url}\n`, "utf8");
      const snapshot = {};
      const proposed = {
        seen_urls: {
          [url]: { decision: "discovered", company: "G", title: "Role", source: "gather" },
        },
        per_company: {},
        last_full_gather: "2026-02-01T00:00:00.000Z",
        auto_promote: false,
      };
      const child = await spawnCrossProcessChild(ws.root, {
        op: "gather_merge",
        snapshot,
        proposed,
        companies: [],
        pause: "beforeMerge",
        pauseToken: "gather-merge",
      });
      await waitForPause(ws.root, "gather-merge");
      await killAndDrain(child);
      await reconcileAll(ws.root);
      const gather = JSON.parse(await fs.readFile(path.join(ws.root, "gather_state.json"), "utf8"));
      expect(gather.seen_urls[url]?.decision).toBe("discovered");
    }, 30_000);
  });

  it(
    "f) traversal slugs and symlinked targets are refused",
    async () => {
      const ws = await freshWorkspace();
      const badSlug = "../applied/evil";
      const promote = await promoteQueueFile(ws.root, badSlug);
      expect(promote.ok).toBe(false);

      const child = await spawnCrossProcessChild(ws.root, {
        op: "reject_discovered",
        slug: badSlug,
        reason: "x",
      });
      const rejectOut = await child.wait();
      expect(rejectOut.code).toBe(0);

      const sentinelQueue = path.join(ws.root, "outside-queue");
      await fs.mkdir(sentinelQueue, { recursive: true });
      const queueDir = path.join(ws.root, "jobs", "queue");
      await fs.rm(queueDir, { recursive: true, force: true });
      await fs.symlink(sentinelQueue, queueDir);
      const slug = "symlink-queue";
      await fs.writeFile(path.join(ws.root, "jobs", "discovered", `${slug}.md`), "url: https://symlink.example/q\n", "utf8");
      const promoteSymlink = await promoteQueueFile(ws.root, slug);
      expect(promoteSymlink.ok).toBe(false);

      const credsSentinel = path.join(ws.root, "outside-creds.json");
      await fs.writeFile(credsSentinel, "{}", "utf8");
      await fs.unlink(credentialsPath(ws.root));
      await fs.symlink(credsSentinel, credentialsPath(ws.root));
      await expect(
        createAccountEntry(ws.root, "safe.example.com", { username: "u", ats: "other" }),
      ).rejects.toMatchObject({ code: "UNSAFE" });

      const gatherSentinel = path.join(ws.root, "outside-gather.json");
      await fs.writeFile(
        gatherSentinel,
        JSON.stringify({ seen_urls: {}, per_company: {} }),
        "utf8",
      );
      const gatherPath = path.join(ws.root, "gather_state.json");
      await fs.unlink(gatherPath);
      await fs.symlink(gatherSentinel, gatherPath);
      const marked = await markSeenUrlPromoted(ws.root, "https://symlink.example/j", {
        company: "C",
        title: "T",
        source: "t",
      });
      expect(marked.ok).toBe(false);
    },
    30_000,
  );

  it(
    "g) restore races a dashboard credentials write; pre-restore captures it, final matches backup",
    async () => {
      const ws = await freshWorkspace();
      initWorkspace(ws.root);
      const creds = credentialsPath(ws.root);
      const originalText = await fs.readFile(creds, "utf8");
      const backupId = createBackup(ws.root, ["credentials.json"]);
      await fs.writeFile(creds, JSON.stringify({ seed: { host: "seed.example.com", username: "s", ats: "other" } }, null, 2), "utf8");

      const dashHost = "dash-write.example.com";
      const child = await spawnCrossProcessChild(ws.root, {
        op: "credentials_write_pause",
        host: dashHost,
        pauseToken: "cred-pause",
      });

      await waitForPause(ws.root, "cred-pause");
      const restorePromise = restoreBackup(ws.root, backupId);
      child.child.kill("SIGKILL");
      await child.wait();
      const { preRestoreId } = await restorePromise;

      const restored = await fs.readFile(creds, "utf8");
      expect(restored).toBe(originalText);
      const backupCredEntry = JSON.parse(
        await fs.readFile(path.join(ws.root, ".pi-jobs", "backups", backupId, "manifest.json"), "utf8"),
      ).files.find((f: { path: string }) => f.path === "credentials.json");
      const backupBytesPath = path.join(ws.root, ".pi-jobs", "backups", backupId, backupCredEntry.backup);
      expect(sha256File(creds)).toBe(sha256File(backupBytesPath));

      const preManifest = JSON.parse(
        await fs.readFile(path.join(ws.root, ".pi-jobs", "backups", preRestoreId, "manifest.json"), "utf8"),
      );
      const credsEntry = preManifest.files.find((f: { path: string }) => f.path === "credentials.json");
      expect(credsEntry).toBeDefined();
      const preBytes = await fs.readFile(
        path.join(ws.root, ".pi-jobs", "backups", preRestoreId, credsEntry.backup),
        "utf8",
      );
      expect(preBytes).toContain("seed.example.com");
      expect(preBytes).not.toContain(dashHost);
      const temps = await fs.readdir(ws.root);
      for (const name of temps) {
        if (/^\.credentials\.json\./.test(name)) {
          await fs.rm(path.join(ws.root, name), { force: true });
        }
      }
      await assertWorkspaceStoresHealthy(ws.root);
    },
    35_000,
  );
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmpRoots: string[] = [];

async function withTempWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, "pi-apps-test-"));
  tmpRoots.push(root);
  await fs.mkdir(path.join(root, "jobs", "queue"), { recursive: true });
  await fs.mkdir(path.join(root, "jobs", "applied"), { recursive: true });
  vi.resetModules();
  vi.doMock("./workspace", async () => {
    const actual = await vi.importActual<typeof import("./workspace")>("./workspace");
    return {
      ...actual,
      WORKSPACE: root,
      wsPath: (...segments: string[]) => path.join(root, ...segments),
      isInWorkspace: (cwd: string) => path.resolve(cwd) === root,
    };
  });
  await run(root);
}

afterEach(async () => {
  vi.doUnmock("./workspace");
  vi.resetModules();
  for (const root of tmpRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("applications", () => {
  it("mutateApplicationState refuses corrupt state", async () => {
    await withTempWorkspace(async (root) => {
      const statePath = path.join(root, "state.json");
      await fs.writeFile(statePath, "", "utf8");
      const { mutateApplicationState } = await import("./applications");
      const result = await mutateApplicationState({ slug: "x", status: "in_progress" }, () => {});
      expect(result.ok).toBe(false);
      expect(await fs.readFile(statePath)).toEqual(Buffer.from(""));
    });
  });

  it("completeApplication removes generated scripts and observation file", async () => {
    await withTempWorkspace(async (root) => {
      const slug = "cleanup-role";
      await fs.mkdir(path.join(root, ".pi-jobs", "scripts"), { recursive: true });
      await fs.mkdir(path.join(root, ".pi-jobs", "observed"), { recursive: true });
      await fs.writeFile(path.join(root, ".pi-jobs", "scripts", `${slug}-submit.js`), "//", "utf8");
      await fs.writeFile(path.join(root, ".pi-jobs", "observed", `${slug}.json`), "{}", "utf8");
      await fs.writeFile(
        path.join(root, "state.json"),
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
      await fs.writeFile(path.join(root, "jobs", "queue", `${slug}.md`), "url: https://ex.test/c\n", "utf8");
      const { completeApplication } = await import("./applications");
      const result = await completeApplication(slug);
      expect(result.ok).toBe(true);
      await expect(fs.stat(path.join(root, ".pi-jobs", "scripts", `${slug}-submit.js`))).rejects.toThrow();
      await expect(fs.stat(path.join(root, ".pi-jobs", "observed", `${slug}.json`))).rejects.toThrow();
    });
  });

  it("completeApplication moves 0-prefixed queue file to applied slug path", async () => {
    await withTempWorkspace(async (root) => {
      const slug = "acme-role";
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          {
            applications: [
              {
                slug,
                status: "submitted",
                queue_file: `jobs/queue/0-${slug}.md`,
                url: "https://example.com/j/1",
              },
            ],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(path.join(root, "jobs", "queue", `0-${slug}.md`), "url: https://example.com/j/1\n", "utf8");
      const { completeApplication } = await import("./applications");
      const result = await completeApplication(slug);
      expect(result.ok).toBe(true);
      expect(await fs.stat(path.join(root, "jobs", "applied", `${slug}.md`))).toBeDefined();
      expect(await fs.stat(path.join(root, "jobs", "queue", `0-${slug}.md`)).catch(() => null)).toBeNull();
      const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
      expect(state.applications[0].queue_file).toBe(`jobs/applied/${slug}.md`);
    });
  });

  it("reopen without reopenApproval is SUBMITTED_LOCKED", async () => {
    await withTempWorkspace(async (root) => {
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug: "x", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      const { mutateApplicationState } = await import("./applications");
      const result = await mutateApplicationState({ slug: "x", status: "in_progress" }, () => {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "SUBMITTED_LOCKED" });
    });
  });

  it("mismatched reopenApproval is OVERRIDE_REQUIRES_USER", async () => {
    await withTempWorkspace(async (root) => {
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug: "x", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      const { mutateApplicationState } = await import("./applications");
      const result = await mutateApplicationState(
        { slug: "x", status: "in_progress", reopenApproval: { submitted_at: "2026-02-01T00:00:00.000Z" } },
        () => {},
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({ code: "OVERRIDE_REQUIRES_USER" });
    });
  });

  it("matching reopenApproval writes reopen record fields", async () => {
    await withTempWorkspace(async (root) => {
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug: "x", status: "submitted", submitted_at: "2026-01-01T00:00:00.000Z" }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      const { mutateApplicationState } = await import("./applications");
      const result = await mutateApplicationState(
        { slug: "x", status: "in_progress", reopenApproval: { submitted_at: "2026-01-01T00:00:00.000Z" } },
        () => {},
      );
      expect(result.ok).toBe(true);
      const state = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
      expect(state.applications[0].reopened_from_submitted_at).toBe("2026-01-01T00:00:00.000Z");
      expect(state.applications[0].reopened_at).toBeTruthy();
      expect(state.applications[0].submitted_at).toBeUndefined();
    });
  });

  it("completeApplication is idempotent when destination exists", async () => {
    await withTempWorkspace(async (root) => {
      const slug = "done";
      await fs.writeFile(
        path.join(root, "jobs", "applied", `${slug}.md`),
        "url: https://example.com\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify({ applications: [{ slug, status: "submitted" }], addresses: {} }, null, 2),
        "utf8",
      );
      const { completeApplication } = await import("./applications");
      const result = await completeApplication(slug);
      expect(result.ok).toBe(true);
    });
  });

  it("completeApplication ignores malicious queue_file paths", async () => {
    await withTempWorkspace(async (root) => {
      const slug = "safe";
      const credPath = path.join(root, "credentials.json");
      await fs.writeFile(credPath, "{}", "utf8");
      await fs.writeFile(
        path.join(root, "jobs", "queue", `${slug}.md`),
        "url: https://example.com\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          {
            applications: [{ slug, status: "submitted", queue_file: "credentials.json" }],
            addresses: {},
          },
          null,
          2,
        ),
        "utf8",
      );
      const { completeApplication } = await import("./applications");
      const result = await completeApplication(slug);
      expect(result.ok).toBe(true);
      expect(await fs.readFile(credPath, "utf8")).toBe("{}");
      await expect(fs.stat(path.join(root, "jobs", "applied", `${slug}.md`))).resolves.toBeDefined();
    });
  });

  it("blocks status change away from submitted without override", async () => {
    await withTempWorkspace(async (root) => {
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify(
          { applications: [{ slug: "x", status: "submitted", submitted_at: "2026-01-01" }], addresses: {} },
          null,
          2,
        ),
        "utf8",
      );
      const { mutateApplicationState } = await import("./applications");
      const result = await mutateApplicationState(
        { slug: "x", status: "in_progress" },
        () => {},
      );
      expect(result.ok).toBe(false);
    });
  });
});

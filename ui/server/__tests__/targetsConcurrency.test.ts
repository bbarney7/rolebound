import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTargets } from "../../../.pi/extensions/lib/targets";
import { readTargets, parseTargetsMarkdown, renderTargetsMarkdown } from "../readers/targets";
import { TargetsRevisionConflictError, writeTargets } from "../targetsWriter";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-targets-cas-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.writeFile(path.join(root, "templates", "targets.template.md"), "# Gather targets\n\n## Greenhouse\n\n");
  return root;
}

function revision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("targets writer concurrency", () => {
  it("creates a missing targets.md only when expectedRevision is null", async () => {
    const root = await workspace();
    const written = await writeTargets(root, [{ source: "greenhouse", slug: "acme" }], null);
    const file = path.join(root, "targets.md");
    expect(await fs.readFile(file, "utf8")).toContain("- acme");
    expect(written.revision).toBe(revision(written.text));
    expect(await readTargets(root)).toMatchObject({ revision: written.revision, entries: [{ source: "greenhouse", slug: "acme" }] });
  });

  it("rejects null expectedRevision when targets.md already exists", async () => {
    const root = await workspace();
    const file = path.join(root, "targets.md");
    const initial = "# Gather targets\n\n## Greenhouse\n\n- incumbent\n";
    await fs.writeFile(file, initial);
    await expect(writeTargets(root, [{ source: "greenhouse", slug: "acme" }], null)).rejects.toBeInstanceOf(TargetsRevisionConflictError);
    expect(await fs.readFile(file, "utf8")).toBe(initial);
  });

  it("rejects stale non-null revisions", async () => {
    const root = await workspace();
    const file = path.join(root, "targets.md");
    const initial = "# Gather targets\n\n## Greenhouse\n\n- incumbent\n";
    await fs.writeFile(file, initial);
    await expect(writeTargets(root, [{ source: "greenhouse", slug: "acme" }], "deadbeef")).rejects.toBeInstanceOf(TargetsRevisionConflictError);
    expect(await fs.readFile(file, "utf8")).toBe(initial);
  });

  it("rejects non-null expectedRevision when the file is still missing", async () => {
    const root = await workspace();
    await expect(writeTargets(root, [{ source: "greenhouse", slug: "acme" }], "deadbeef")).rejects.toBeInstanceOf(TargetsRevisionConflictError);
    expect(await fs.stat(path.join(root, "targets.md")).catch(() => null)).toBeNull();
  });

  it("serializes concurrent writes so only one stale revision succeeds", async () => {
    const root = await workspace();
    const file = path.join(root, "targets.md");
    const initial = "# Gather targets\n\n## Greenhouse\n\n- incumbent\n";
    await fs.writeFile(file, initial);
    const current = revision(initial);
    const first = writeTargets(root, [{ source: "greenhouse", slug: "first" }], current);
    const second = writeTargets(root, [{ source: "greenhouse", slug: "second" }], current);
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const saved = await fs.readFile(file, "utf8");
    expect(saved.includes("- first") || saved.includes("- second")).toBe(true);
    expect(saved.includes("- first") && saved.includes("- second")).toBe(false);
  });

  it("rejects symlink targets.md before mutating an external sentinel", async () => {
    const root = await workspace();
    const sentinel = path.join(root, "outside-targets.md");
    await fs.writeFile(sentinel, "SENTINEL");
    const file = path.join(root, "targets.md");
    await fs.symlink(sentinel, file);
    await expect(writeTargets(root, [{ source: "greenhouse", slug: "acme" }], null)).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(sentinel, "utf8")).toBe("SENTINEL");
  });

  it("preserves custom markdown while updating list entries", async () => {
    const root = await workspace();
    const file = path.join(root, "targets.md");
    const custom = `# Gather targets

Custom note that must survive edits.

## Greenhouse

- old-co
`;
    await fs.writeFile(file, custom);
    const current = revision(custom);
    const written = await writeTargets(root, [{ source: "greenhouse", slug: "new-co" }], current);
    expect(written.text).toContain("Custom note that must survive edits.");
    expect(written.text).toContain("- new-co");
    expect(written.text).not.toContain("- old-co");
  });

  it("renders output that shared parseTargets accepts", async () => {
    const root = await workspace();
    const baseline = await fs.readFile(path.join(root, "templates", "targets.template.md"), "utf8");
    const rendered = renderTargetsMarkdown(baseline, [
      { source: "greenhouse", slug: "fixture-co" },
      { source: "ashby", slug: "other-co" },
    ]);
    expect(parseTargets(rendered)).toEqual([
      { source: "greenhouse", slug: "fixture-co" },
      { source: "ashby", slug: "other-co" },
    ]);
    expect(parseTargetsMarkdown(rendered)).toEqual(parseTargets(rendered));
  });
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseInstructionsDocument,
  readInstructions,
  writeInstructionSection,
  writeInstructions,
} from "./instructions";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-"));
  roots.push(root);
  return root;
}

describe("instructions.md", () => {
  it("returns empty sections when the file is missing", async () => {
    const root = await tempRoot();
    expect(await readInstructions(root)).toEqual({ applying: "", finding: "", chat: "" });
  });

  it("writes one section while preserving the others and stray text", async () => {
    const root = await tempRoot();
    const file = path.join(root, "instructions.md");
    await fs.writeFile(
      file,
      "Preamble stays\n\n## Applying\n\nold apply\n\n## Custom\n\nkeep me\n\n## Finding and scoring\n\nscore rules\n\n## Chat\n\n",
      "utf8",
    );
    await writeInstructionSection(root, "applying", "new apply", "replace");
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain("Preamble stays");
    expect(text).toContain("## Custom");
    expect(text).toContain("keep me");
    expect(text).toContain("new apply");
    expect(text).not.toContain("old apply");
    expect(text).toContain("score rules");
    expect(await readInstructions(root)).toMatchObject({
      applying: "new apply",
      finding: "score rules",
      chat: "",
    });
  });

  it("round-trips all three sections through writeInstructions", async () => {
    const root = await tempRoot();
    const first = await writeInstructions(
      root,
      { applying: "Apply rule", finding: "Score rule", chat: "Chat rule" },
      null,
    );
    const second = await writeInstructions(
      root,
      { applying: "Apply rule 2", finding: "Score rule 2", chat: "Chat rule 2" },
      first.revision,
    );
    expect(second.revision).not.toBe(first.revision);
    expect(await readInstructions(root)).toEqual({
      applying: "Apply rule 2",
      finding: "Score rule 2",
      chat: "Chat rule 2",
    });
    const parts = parseInstructionsDocument(await fs.readFile(path.join(root, "instructions.md"), "utf8"));
    expect(parts.filter((p) => p.kind === "section").map((p) => (p as { key: string }).key)).toEqual([
      "applying",
      "finding",
      "chat",
    ]);
  });
});

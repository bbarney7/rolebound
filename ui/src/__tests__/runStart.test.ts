import { describe, expect, it, vi, beforeEach } from "vitest";
import { startRun } from "../runs";

vi.mock("../http", () => ({
  httpFetch: vi.fn(),
}));

import { httpFetch } from "../http";

describe("startRun", () => {
  beforeEach(() => {
    vi.mocked(httpFetch).mockReset();
  });

  it("passes continueFrom in the POST body", async () => {
    vi.mocked(httpFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        runId: "new",
        kind: "chat",
        slug: null,
        sessionName: "ui:chat",
        model: "m",
        status: "starting",
        startedAt: "",
        endedAt: null,
        pid: 1,
        firstSeq: 0,
        lastSeq: 0,
      }),
    } as Response);

    await startRun({ kind: "chat", message: "hi", continueFrom: "old-run" });

    expect(httpFetch).toHaveBeenCalledWith(
      "/api/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "chat", message: "hi", continueFrom: "old-run" }),
      }),
    );
  });
});

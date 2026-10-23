// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InstructionsView from "../InstructionsView";
import * as api from "../api";

describe("InstructionsView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads, edits, and saves with expectedRevision", async () => {
    const fetchMock = vi.spyOn(api, "fetchInstructions").mockResolvedValue({
      revision: null,
      data: { applying: "", finding: "", chat: "" },
    });
    const updateMock = vi.spyOn(api, "updateInstructions").mockResolvedValue({
      revision: "abc123",
      data: { applying: "Midpoint salary", finding: "", chat: "" },
    });

    render(<InstructionsView />);
    await waitFor(() => expect(screen.getByLabelText("When applying")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("When applying"), { target: { value: "Midpoint salary" } });
    const save = screen.getByRole("button", { name: "Save instructions" });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({
        applying: "Midpoint salary",
        finding: "",
        chat: "",
        expectedRevision: null,
      }),
    );
    expect(fetchMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
  });
});

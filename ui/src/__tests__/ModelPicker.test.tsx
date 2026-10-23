// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import ModelPicker from "../components/ModelPicker";

function Example({ onSubmit = () => {}, onEscape = () => {} }) {
  const [value, setValue] = useState("");
  return <form onSubmit={e => { e.preventDefault(); onSubmit(); }} onKeyDown={e => { if (e.key === "Escape") onEscape(); }}>
    <label htmlFor="model">Model</label>
    <ModelPicker id="model" value={value} onChange={setValue} models={[{id:"alpha-model"},{id:"beta-model",label:"Beta"}]} />
    <button type="submit">Save</button>
  </form>;
}
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("ModelPicker", () => {
  it("filters and selects by keyboard without submitting the form", async () => {
    const submit = vi.fn(); const user = userEvent.setup();
    render(<Example onSubmit={submit} />);
    const input = screen.getByRole("combobox", {name:"Model"});
    await user.type(input, "beta");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.keyboard("{ArrowDown}{Enter}");
    expect((input as HTMLInputElement).value).toBe("beta-model");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
  it("commits a custom ID only through its explicit option", async () => {
    const user = userEvent.setup(); render(<Example />);
    const input = screen.getByRole("combobox", {name:"Model"});
    await user.type(input, "private-model");
    await user.tab();
    expect((input as HTMLInputElement).value).toBe("");
    await user.click(input); await user.type(input,"private-model");
    await user.click(screen.getByRole("option", {name:/Use custom model ID/}));
    expect((input as HTMLInputElement).value).toBe("private-model");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("Escape dismisses suggestions without escaping the surrounding dialog", async () => {
    const escape = vi.fn(); const user = userEvent.setup(); render(<Example onEscape={escape} />);
    await user.click(screen.getByRole("combobox", {name:"Model"}));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull(); expect(escape).not.toHaveBeenCalled();
  });
  it("selects an option by pointer and returns focus to the input", async () => {
    const user = userEvent.setup(); render(<Example />);
    const input = screen.getByRole("combobox", {name:"Model"});
    await user.click(input); await user.click(screen.getByRole("option", {name:"Beta beta-model"}));
    expect((input as HTMLInputElement).value).toBe("beta-model");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { useUnsavedChanges, useWorkspaceState, WorkspaceDraftProvider } from "../WorkspaceDrafts";
afterEach(cleanup);
function Editor() {
  const [value,setValue] = useWorkspaceState("draft", "saved");
  useUnsavedChanges("draft",value !== "saved");
  return <><input aria-label="Draft" value={value} onChange={e => setValue(e.target.value)} /><button onClick={() => setValue("saved")}>Save</button></>;
}
function Shell() { const [open,setOpen] = useState(true); return <WorkspaceDraftProvider><button onClick={() => setOpen(!open)}>Switch section</button>{open && <Editor />}</WorkspaceDraftProvider>; }
it("keeps a draft across unmounts and warns until saved, without browser storage",async () => {
  const user = userEvent.setup(); render(<Shell />);
  await user.clear(screen.getByLabelText("Draft")); await user.type(screen.getByLabelText("Draft"),"unsaved edit");
  await user.click(screen.getByRole("button",{name:"Switch section"}));
  const dirty = new Event("beforeunload",{cancelable:true}); window.dispatchEvent(dirty); expect(dirty.defaultPrevented).toBe(true);
  await user.click(screen.getByRole("button",{name:"Switch section"})); expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("unsaved edit");
  await user.click(screen.getByRole("button",{name:"Save"}));
  const clean = new Event("beforeunload",{cancelable:true}); window.dispatchEvent(clean); expect(clean.defaultPrevented).toBe(false);
  expect(localStorage.getItem("draft")).toBeNull();
});

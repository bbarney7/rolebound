// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceDrawer, { hrefForStoredSection } from "../chat/WorkspaceDrawer";
afterEach(cleanup);
describe("WorkspaceDrawer", () => {
  it("groups the canonical destinations and handles native cancel", () => {
    const onClose = vi.fn();
    render(<WorkspaceDrawer open view="profile" tab="resumes" counts={{queue:3,applications:12}} onNavigate={() => {}} onClose={onClose}><p>Panel body</p></WorkspaceDrawer>);
    const nav = screen.getByRole("navigation",{name:"Workspace sections"});
    expect(within(nav).getAllByRole("link").map(link => link.textContent)).toEqual(["Profile","Job search","Agent instructions","Applications12","Settings","Setup"]);
    expect(within(nav).getByRole("link",{name:"Profile"}).getAttribute("aria-current")).toBe("page");
    fireEvent(screen.getByRole("dialog"),new Event("cancel",{bubbles:true,cancelable:true}));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button",{name:"Close workspace"}));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it("preserves stored legacy destinations", () => {
    expect(hrefForStoredSection("resumes")).toBe("/profile?tab=resumes");
    expect(hrefForStoredSection("searchPreferences")).toBe("/profile?tab=searchPreferences");
    expect(hrefForStoredSection("accounts")).toBe("/settings/accounts");
    expect(hrefForStoredSection("queue")).toBe("/queue");
  });
});

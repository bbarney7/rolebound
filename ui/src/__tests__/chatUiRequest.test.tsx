// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Transcript from "../chat/Transcript";

describe("ui_request confirm", () => {
  it("clicking Yes calls onRespondUi with confirmed true", async () => {
    const onRespondUi = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Transcript
        run={null}
        entries={[
          {
            kind: "ui_request",
            key: "u1",
            id: "req-42",
            method: "confirm",
            title: "Submit this application?",
            resolved: false,
          },
        ]}
        onSend={vi.fn()}
        onRespondUi={onRespondUi}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onRespondUi).toHaveBeenCalledWith({ id: "req-42", confirmed: true });
  });
});

describe("ui_request input", () => {
  it("names the answer box after the request title", () => {
    render(
      <Transcript
        run={null}
        entries={[
          {
            kind: "ui_request",
            key: "u2",
            id: "req-43",
            method: "input",
            title: "Enter the emailed security code",
            resolved: false,
          },
        ]}
        onSend={vi.fn()}
        onRespondUi={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Enter the emailed security code" })).toBeTruthy();
  });
});

it("collapses typed diagnostics while keeping errors, warnings and requests visible", () => {
  const {container} = render(<Transcript run={null} entries={[
    {kind:"system",key:"s",text:"Routine diagnostic",source:"status_line",severity:"info"},
    {kind:"system",key:"e",text:"Provider failed",source:"error",severity:"error"},
    {kind:"notify",key:"w",text:"Check this warning",level:"warning"},
    {kind:"ui_request",key:"q",id:"q",method:"input",title:"Your answer",resolved:false},
  ]} onSend={() => {}} onRespondUi={async () => {}} />);
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Provider failed");
  expect(screen.getByText("Check this warning").closest("details")).toBeNull();
  expect(screen.getByRole("textbox",{name:"Your answer"}).closest("details")).toBeNull();
});

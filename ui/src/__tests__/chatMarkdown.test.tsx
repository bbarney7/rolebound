// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../chat/markdown";

describe("chat markdown", () => {
  it("renders a javascript: link as plain text, not an anchor", () => {
    render(<div>{renderMarkdown("Click [evil](javascript:alert(1)) here")}</div>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("evil")).toBeTruthy();
  });

  it("renders https links as anchors", () => {
    render(<div>{renderMarkdown("See [docs](https://example.com) now")}</div>);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("structured and streamed Markdown", () => {
  it("renders headings, nested lists, code and tables without executing HTML", () => {
    const {container} = render(<>{renderMarkdown('## Roles\n\n| Company | Fit |\n| --- | --- |\n| Acme | High |\n\n- Outer\n  - Inner\n\n```js\nconst x = 1\n```\n\n<script>alert(1)</script>')}</>);
    expect(container.querySelector("h2")?.textContent).toBe("Roles");
    expect(container.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(container.querySelector("ul ul")?.textContent).toContain("Inner");
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1");
    expect(container.querySelector("script")).toBeNull();
  });
  it("accepts an incomplete stream and preserves the caret until completion", () => {
    const {container,rerender} = render(<>{renderMarkdown('| Name | Fit |\n| --',{caret:true})}</>);
    expect(container.querySelector(".rb-chat-caret")).toBeTruthy();
    rerender(<>{renderMarkdown('| Name | Fit |\n| --- | --- |\n| Acme | High |')}</>);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelector(".rb-chat-caret")).toBeNull();
  });
});

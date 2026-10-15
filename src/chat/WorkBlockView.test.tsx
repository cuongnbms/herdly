import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatItem } from "../lib/types";
import { WorkBlockView } from "./WorkBlockView";
import type { ToolResult, WorkBlock } from "./workBlocks";

const block: WorkBlock = {
  id: "a",
  items: [
    { kind: "assistant_text", markdown: "Checking the files." },
    { kind: "tool_call", id: "a", name: "Bash", input_summary: "ls", input: { command: "ls" } },
  ],
  start: "2026-10-03T00:00:00Z",
  end: "2026-10-03T00:00:07Z",
};
const results = new Map<string, ToolResult>([["a", { kind: "tool_result", call_id: "a", output: "a.txt", is_error: false }]]);

describe("WorkBlockView", () => {
  it("folds to its header", () => {
    render(<WorkBlockView block={block} results={results} open={false} onToggle={() => {}} live={false} />);
    expect(screen.getByRole("button", { name: /Worked for 7s · 1 command/ })).toBeTruthy();
    expect(screen.queryByText("Checking the files.")).toBeNull();
  });

  it("asks to toggle when its header is clicked", () => {
    const onToggle = vi.fn();
    render(<WorkBlockView block={block} results={results} open={false} onToggle={onToggle} live={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Worked/ }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("a", false);
  });

  it("shows narration and tool rows when open", () => {
    render(<WorkBlockView block={block} results={results} open onToggle={() => {}} live={false} />);
    expect(screen.getByText("Checking the files.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("reads Working… while the agent runs", () => {
    render(<WorkBlockView block={block} results={results} open onToggle={() => {}} live />);
    expect(screen.getByRole("button", { name: /Working…/ })).toBeTruthy();
  });

  it("reads Worked when the span is unknown", () => {
    const untimed: WorkBlock = { ...block, start: null };
    render(<WorkBlockView block={untimed} results={results} open={false} onToggle={() => {}} live={false} />);
    expect(screen.getByRole("button", { name: /^Worked · 1 command$/ })).toBeTruthy();
  });
});

describe("runs of calls in a work block", () => {
  const ls = (id: string): ChatItem => ({ kind: "tool_call", id, name: "Bash", input_summary: `ls ${id}`, input: { command: `ls ${id}` } });
  const run: WorkBlock = { ...block, items: [{ kind: "assistant_text", markdown: "Checking the files." }, ls("x"), ls("y"), { kind: "thinking", text: "hm" }] };
  const failed = new Map<string, ToolResult>([["y", { kind: "tool_result", call_id: "y", output: "boom", is_error: true }]]);

  it("folds a run under one summary line that opens to its calls", () => {
    render(<WorkBlockView block={run} results={failed} open onToggle={() => {}} live={false} />);
    expect(screen.getByText("Checking the files.")).toBeTruthy();
    expect(screen.queryByText("ls x")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^2 commands · 1 failed$/ }));
    expect(screen.getByText("ls x")).toBeTruthy();
    expect(screen.getByText("ls y")).toBeTruthy();
  });

  it("leaves the calls still arriving open while the agent runs", () => {
    render(<WorkBlockView block={{ ...run, items: run.items.slice(0, 3) }} results={failed} open onToggle={() => {}} live />);
    expect(screen.getByText("ls x")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^2 commands/ })).toBeNull();
  });
});

describe("TodoWrite in a work block", () => {
  const todo: ChatItem = {
    kind: "tool_call", id: "t", name: "TodoWrite", input_summary: "",
    input: { todos: [{ content: "Write tests", status: "completed" }, { content: "Implement", status: "in_progress" }, { content: "Ship", status: "pending" }] },
  };
  const ok = new Map<string, ToolResult>([["t", { kind: "tool_result", call_id: "t", output: "Todos have been modified successfully.", is_error: false }]]);

  it("summarizes the list and opens to a checklist instead of the raw result", () => {
    render(<WorkBlockView block={{ ...block, items: [todo] }} results={ok} open onToggle={() => {}} live={false} />);
    fireEvent.click(screen.getByRole("button", { name: /TodoWrite\s*·\s*1\/3 done/ }));
    expect(screen.getByRole("list", { name: "Todos" })).toBeTruthy();
    expect(screen.getByText("Implement").closest("li")?.className).toContain("in_progress");
    expect(screen.queryByText("Todos have been modified successfully.")).toBeNull();
  });
});

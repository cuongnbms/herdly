import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/types";
import { buildRows, formatWorkDuration, groupCalls, workSummary, type ChatRow, type WorkSegment } from "./workBlocks";

const user = (text: string, ts?: string): ChatItem => ({ kind: "user", text, ts });
const say = (markdown: string, ts?: string): ChatItem => ({ kind: "assistant_text", markdown, ts });
const think = (text: string, ts?: string): ChatItem => ({ kind: "thinking", text, ts });
const call = (id: string, name = "Bash", input: unknown = {}, ts?: string): ChatItem => ({ kind: "tool_call", id, name, input_summary: "", input, ts });
const result = (call_id: string, is_error = false, ts?: string): ChatItem => ({ kind: "tool_result", call_id, output: "out", is_error, ts });

/** A row as `user:hi`, `say:Done`, `work[call:a,result:b]`: enough to read a grouping at a glance. */
function shape(rows: ChatRow[]): string[] {
  const one = (it: ChatItem): string =>
    it.kind === "user" ? `user:${it.text}`
      : it.kind === "assistant_text" ? `say:${it.markdown}`
        : it.kind === "thinking" ? `think:${it.text}`
          : it.kind === "tool_call" ? `call:${it.id}`
            : it.kind === "tool_result" ? `result:${it.call_id}`
              : it.kind === "shell_command" ? `shell:${it.command}`
                : it.kind === "shell_output" ? `out:${it.stdout}`
                  : `system:${it.text}`;
  return rows.map((r) => (r.kind === "item" ? one(r.item) : `work[${r.block.items.map(one).join(",")}]`));
}

describe("buildRows", () => {
  it("gives each row the absolute index of its first item", () => {
    const rows = buildRows([user("1", "t1"), think("hm"), call("a"), say("done")], 5).rows;
    expect(rows.map((r) => [r.key, r.at])).toEqual([["i:5", 5], ["w:turn:t1", 6], ["i:8", 8]]);
  });

  it("keys rows by block id or absolute item index, stable across a prepend", () => {
    const newer = [user("2", "t2"), call("b"), say("y")];
    const after = buildRows(newer, 10).rows.map((r) => r.key);
    const before = buildRows([user("1", "t1"), say("x"), ...newer], 8).rows.map((r) => r.key);
    expect(after).toEqual(["i:10", "w:turn:t2", "i:12"]);
    expect(before.slice(-3)).toEqual(after);
  });

  it("folds a turn's work into one block and leaves the answer open", () => {
    const { rows } = buildRows([user("hi"), think("hmm"), say("Looking."), call("a"), result("a"), call("b"), result("b"), say("Done.")]);
    expect(shape(rows)).toEqual(["user:hi", "work[think:hmm,say:Looking.,call:a,call:b]", "say:Done."]);
  });

  it("joins results to their calls", () => {
    const { results } = buildRows([user("hi"), call("a"), result("a", true)]);
    expect(results.get("a")?.is_error).toBe(true);
  });

  it("gives a turn without actions no block", () => {
    expect(shape(buildRows([user("hi"), say("Hello.")]).rows)).toEqual(["user:hi", "say:Hello."]);
  });

  it("starts a new turn at a system line", () => {
    const { rows } = buildRows([user("go"), call("a"), say("ok"), { kind: "system", text: "Agent finished" }, call("b"), say("done")]);
    expect(shape(rows)).toEqual(["user:go", "work[call:a]", "say:ok", "system:Agent finished", "work[call:b]", "say:done"]);
  });

  it("keeps a shell command and its output out of the agent's work", () => {
    const { rows } = buildRows([user("go"), call("a"), say("ok"), { kind: "shell_command", command: "ls" }, { kind: "shell_output", stdout: "a.txt", stderr: "" }, call("b"), say("done")]);
    expect(shape(rows)).toEqual(["user:go", "work[call:a]", "say:ok", "shell:ls", "out:a.txt", "work[call:b]", "say:done"]);
  });

  it("keeps a result whose call is not loaded inside the block", () => {
    const { rows } = buildRows([result("gone"), call("a"), result("a"), say("done")]);
    expect(shape(rows)).toEqual(["work[result:gone,call:a]", "say:done"]);
  });

  it("marks only the last turn's block as last", () => {
    const { rows } = buildRows([user("1"), call("a"), say("x"), user("2"), call("b"), say("y")]);
    const blocks = rows.filter((r) => r.kind === "work");
    expect(blocks.map((b) => b.kind === "work" && b.last)).toEqual([false, true]);
  });

  it("names a block by its first call so it keeps its identity when older items load", () => {
    const newer = [call("a"), result("a"), say("done")];
    const before = buildRows(newer).rows.find((r) => r.kind === "work");
    const after = buildRows([user("hi"), think("t"), ...newer]).rows.find((r) => r.kind === "work");
    expect(before?.kind === "work" && before.block.id).toBe("a");
    expect(after?.kind === "work" && after.block.id).toBe("a");
  });

  it("keeps a live block's id when its first call follows thinking", () => {
    const id = (items: ChatItem[]) => {
      const b = buildRows(items).rows.find((r) => r.kind === "work");
      return b?.kind === "work" ? b.block.id : null;
    };
    const opener = user("hi", "2026-10-03T00:00:00Z");
    expect(id([opener, think("t")])).toBe(id([opener, think("t"), call("a"), result("a")]));
  });

  it("drops a block left with nothing to show instead of throwing", () => {
    // The result's call sits in an earlier turn, where it renders.
    const { rows } = buildRows([user("1"), call("a"), say("x"), user("2"), result("a"), say("y")]);
    expect(shape(rows)).toEqual(["user:1", "work[call:a]", "say:x", "user:2", "say:y"]);
  });

  it("times a block from the user's message to its last activity", () => {
    const { rows } = buildRows([
      user("hi", "2026-10-03T00:00:00Z"),
      call("a", "Bash", {}, "2026-10-03T00:00:02Z"),
      result("a", false, "2026-10-03T00:00:07Z"),
      say("done", "2026-10-03T00:00:09Z"),
    ]);
    const block = rows.find((r) => r.kind === "work");
    expect(block?.kind === "work" && [block.block.start, block.block.end]).toEqual(["2026-10-03T00:00:00Z", "2026-10-03T00:00:07Z"]);
  });

  it("times from the first work item when the user's message is not loaded", () => {
    const { rows } = buildRows([call("a", "Bash", {}, "2026-10-03T00:00:02Z"), result("a", false, "2026-10-03T00:00:05Z"), say("done")]);
    const block = rows.find((r) => r.kind === "work");
    expect(block?.kind === "work" && block.block.start).toBe("2026-10-03T00:00:02Z");
  });
});

describe("workSummary", () => {
  it("counts edits, reads, commands and failures in that order", () => {
    const items = [call("1", "Read"), call("2", "Edit"), call("3", "Bash"), call("4", "Write"), call("5", "Grep"), call("6", "WebFetch")];
    const results = new Map([["3", { kind: "tool_result" as const, call_id: "3", output: "", is_error: true }]]);
    expect(workSummary(items, results)).toBe("2 edits · 2 file reads · 1 command · 1 other tool · 1 failed");
  });

  it("does not count a todo list as an edit", () => {
    const todo = call("t", "TodoWrite", { todos: [{ content: "x", status: "pending" }] });
    expect(workSummary([todo, call("e", "Edit")], new Map())).toBe("1 edit");
  });
});

describe("groupCalls", () => {
  const todo = call("t", "TodoWrite", { todos: [{ content: "x", status: "pending" }] });
  /** `calls[a,b]` for a group, `call:a` / `say:x` / `think:x` / `result:a` for a lone item. */
  const segs = (segments: WorkSegment[]): string[] =>
    segments.map((s) => {
      if (s.kind === "calls") return `calls[${s.calls.map((c) => c.id).join(",")}]`;
      const it = s.item;
      return it.kind === "tool_call" ? `call:${it.id}`
        : it.kind === "assistant_text" ? `say:${it.markdown}`
          : it.kind === "thinking" ? `think:${it.text}`
            : it.kind === "tool_result" ? `result:${it.call_id}`
              : it.kind;
    });

  it("folds two or more calls in a row under one group and leaves a lone call alone", () => {
    expect(segs(groupCalls([say("Looking."), call("a"), call("b"), call("c"), say("Now the logs."), call("d")], false)))
      .toEqual(["say:Looking.", "calls[a,b,c]", "say:Now the logs.", "call:d"]);
  });

  it("breaks a run at thinking and at a result whose call is not loaded", () => {
    expect(segs(groupCalls([call("a"), call("b"), think("hm"), call("c"), result("x"), call("d"), call("e")], false)))
      .toEqual(["calls[a,b]", "think:hm", "call:c", "result:x", "calls[d,e]"]);
  });

  it("keeps a todo list out of a group, since it is the plan", () => {
    expect(segs(groupCalls([call("a"), todo, call("b"), call("c")], false))).toEqual(["call:a", "call:t", "calls[b,c]"]);
  });

  it("leaves the calls still arriving in a live block open, and folds earlier runs", () => {
    expect(segs(groupCalls([call("a"), call("b"), say("Next."), call("c"), call("d")], true)))
      .toEqual(["calls[a,b]", "say:Next.", "call:c", "call:d"]);
    expect(segs(groupCalls([call("a"), call("b"), think("hm")], true))).toEqual(["calls[a,b]", "think:hm"]);
  });
});

describe("formatWorkDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatWorkDuration("2026-10-03T00:00:00Z", "2026-10-03T00:00:07Z")).toBe("7s");
    expect(formatWorkDuration("2026-10-03T00:00:00Z", "2026-10-03T00:01:12Z")).toBe("1m 12s");
    expect(formatWorkDuration("2026-10-03T00:00:00Z", "2026-10-03T00:02:00Z")).toBe("2m");
    expect(formatWorkDuration("2026-10-03T00:00:00Z", "2026-10-03T01:05:00Z")).toBe("1h 5m");
  });

  it("is null when a time is missing or the span is negative", () => {
    expect(formatWorkDuration(null, "2026-10-03T00:00:07Z")).toBeNull();
    expect(formatWorkDuration("2026-10-03T00:00:07Z", "2026-10-03T00:00:00Z")).toBeNull();
    expect(formatWorkDuration("garbage", "2026-10-03T00:00:00Z")).toBeNull();
  });
});

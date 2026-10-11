import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_REPLIES,
  loadQuickReplies,
  moveReply,
  normalizeReplies,
  QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX_CHARS,
  quickReplyButtons,
  useQuickReplies,
} from "./quickReplies";

const KEY = "herdly:settings";

beforeEach(() => {
  localStorage.clear();
  useQuickReplies.setState(loadQuickReplies());
});

describe("quick replies", () => {
  it("defaults to shown, with the canned list", () => {
    expect(loadQuickReplies()).toEqual({ show: true, replies: DEFAULT_QUICK_REPLIES });
    expect(DEFAULT_QUICK_REPLIES).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
  });

  it("keeps strings only, capped in count and length; anything else falls back to the defaults", () => {
    expect(normalizeReplies(["ok", 3, null, "x".repeat(QUICK_REPLY_MAX_CHARS + 5)])).toEqual(["ok", "x".repeat(QUICK_REPLY_MAX_CHARS)]);
    expect(normalizeReplies(Array.from({ length: 20 }, (_, i) => `r${i}`))).toHaveLength(QUICK_REPLIES_MAX);
    expect(normalizeReplies("continue")).toEqual(DEFAULT_QUICK_REPLIES);
    expect(normalizeReplies([])).toEqual([]);
  });

  it("offers a button only for the replies with text", () => {
    expect(quickReplyButtons(["run the ", "", "  ", "ship it"])).toEqual(["run the ", "ship it"]);
  });

  it("saves into the shared settings object without dropping other keys", () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "light" }));
    useQuickReplies.getState().setReplies(["go on", ""]);
    useQuickReplies.getState().setShow(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ theme: "light", quickReplies: ["go on", ""], showQuickReplies: false });
    expect(loadQuickReplies()).toEqual({ show: false, replies: ["go on", ""] });
  });

  it("resets the list to the defaults", () => {
    useQuickReplies.getState().setReplies(["only"]);
    useQuickReplies.getState().reset();
    expect(useQuickReplies.getState().replies).toEqual(DEFAULT_QUICK_REPLIES);
    expect(loadQuickReplies().replies).toEqual(DEFAULT_QUICK_REPLIES);
  });

  it("moves a reply to the side of another it is dropped on", () => {
    const list = ["a", "b", "c", "d"];
    expect(moveReply(list, 0, 2, "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveReply(list, 0, 2, "before")).toEqual(["b", "a", "c", "d"]);
    expect(moveReply(list, 3, 1, "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveReply(list, 3, 0, "after")).toEqual(["a", "d", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("gives null for a move that would leave the reply where it is, or point past the list", () => {
    const list = ["a", "b", "c"];
    expect(moveReply(list, 1, 1, "before")).toBeNull();
    expect(moveReply(list, 1, 0, "after")).toBeNull();
    expect(moveReply(list, 1, 2, "before")).toBeNull();
    expect(moveReply(list, 0, -1, "before")).toBeNull();
    expect(moveReply(list, 2, 3, "after")).toBeNull();
  });
});

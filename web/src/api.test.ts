import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, paneKeys, paneRead } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("posts JSON with the pane and returns read text", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "screen" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await paneRead({ session: "s", pane_id: "p1" })).toBe("screen");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/pane/read");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ session: "s", pane_id: "p1" });
  });

  it("throws ApiError with status and code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "herdr_error", message: "boom" }), { status: 502 })));
    const e = await paneKeys({ session: "s", pane_id: "p1" }, ["esc"]).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.message]).toEqual([502, "herdr_error", "boom"]);
  });
});

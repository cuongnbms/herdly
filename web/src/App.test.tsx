import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useWeb } from "./store";

beforeEach(() => useWeb.setState({ conn: "open", machines: [], chats: {} }));

describe("App", () => {
  it("shows the pairing hint only when unpaired", () => {
    const { unmount } = render(<App />);
    expect(screen.queryByText("Not paired")).not.toBeInTheDocument();
    unmount();
    useWeb.setState({ conn: "unpaired" });
    render(<App />);
    expect(screen.getByRole("heading", { name: "Not paired" })).toBeInTheDocument();
    expect(screen.getByText("Open a pairing link from herdly-web pair on the devbox.")).toBeInTheDocument();
  });

  it("shows the reconnecting bar only while down", () => {
    const { rerender } = render(<App />);
    expect(screen.queryByText("Disconnected, reconnecting…")).not.toBeInTheDocument();
    useWeb.setState({ conn: "down" });
    rerender(<App />);
    expect(screen.getByText("Disconnected, reconnecting…")).toBeInTheDocument();
  });
});

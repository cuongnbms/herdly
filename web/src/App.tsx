import type { Socket } from "./socket";
import { useWeb } from "./store";

function NotPaired() {
  return (
    <main>
      <h1>Not paired</h1>
      <p>Open a pairing link from herdly-web pair on the devbox.</p>
    </main>
  );
}

/** `socket` is main.tsx's one connection; the screens built on this shell subscribe through it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function App(_props: { socket?: Socket }) {
  const conn = useWeb((s) => s.conn);
  if (conn === "unpaired") return <NotPaired />;
  return (
    <>
      {conn === "down" && <div role="status">Disconnected, reconnecting…</div>}
      <main />
    </>
  );
}

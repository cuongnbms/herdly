import { useEffect, useRef, useState } from "react";
import { filesHtmlDrop, filesHtmlPut } from "../lib/ipc";

const drop = (token: string) => {
  filesHtmlDrop(token).catch(() => {});
};

/**
 * `text` stored as a page and shown in a sandboxed frame; `scripts` is whether the page may run scripts.
 * A change of `reloads` (⌘R) stores the page again even when the text is the same, so it loads afresh.
 */
export function HtmlView({ text, scripts, reloads = 0 }: { text: string; scripts: boolean; reloads?: number }) {
  // The frame's sandbox follows the Scripts value its page was stored with, not the current prop.
  const [shown, setShown] = useState<{ token: string; scripts: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownToken = useRef<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let stale = false;
    setError(null);
    // `stale` drops the answer of a store this effect no longer wants.
    filesHtmlPut(text, scripts).then(
      (token) => {
        if (stale) return drop(token);
        if (shownToken.current) drop(shownToken.current);
        shownToken.current = token;
        setShown({ token, scripts });
      },
      (e) => {
        if (!stale) setError(String((e as { message?: string })?.message ?? e));
      },
    );
    return () => {
      stale = true;
    };
  }, [text, scripts, reloads]);

  useEffect(
    () => () => {
      if (shownToken.current) drop(shownToken.current);
      shownToken.current = null;
    },
    [],
  );

  if (error !== null) {
    return (
      <div className="files-notice" role="alert">
        Cannot show this page: {error}
      </div>
    );
  }
  return (
    <div
      className="files-html-wrap"
      // Keys typed in the frame go to its own document, past the app's shortcuts; leaving it gives them back.
      onPointerLeave={() => {
        if (frame.current && document.activeElement === frame.current) frame.current.blur();
      }}
    >
      {shown && (
        <iframe
          ref={frame}
          className="files-html"
          src={`herdly-html://localhost/${shown.token}`}
          sandbox={shown.scripts ? "allow-scripts" : ""}
          title="HTML preview"
        />
      )}
    </div>
  );
}

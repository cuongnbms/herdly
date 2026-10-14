import { useEffect, useRef, useState } from "react";
import { filesHtmlDrop, filesHtmlPut } from "../lib/ipc";

const drop = (token: string) => {
  filesHtmlDrop(token).catch(() => {});
};

/** `text` stored as a page and shown in a sandboxed frame; `scripts` is whether the page may run scripts. */
export function HtmlView({ text, scripts }: { text: string; scripts: boolean }) {
  // The frame's sandbox follows the Scripts value its page was stored with, not the current prop.
  const [shown, setShown] = useState<{ token: string; scripts: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownToken = useRef<string | null>(null);

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
  }, [text, scripts]);

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
    <div className="files-html-wrap">
      {shown && (
        <iframe
          className="files-html"
          src={`herdly-html://localhost/${shown.token}`}
          sandbox={shown.scripts ? "allow-scripts" : ""}
          title="HTML preview"
        />
      )}
    </div>
  );
}

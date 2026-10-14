import type { FileContent } from "../lib/types";
import type { FindQuery, FindStatus } from "./find";
import { HtmlView } from "./HtmlView";
import { ImageView } from "./ImageView";
import { isHtml, isMarkdown } from "./kinds";
import { lineOfHash } from "./links";
import { MarkdownView } from "./MarkdownView";
import { TextView } from "./TextView";

export type FileMode = "render" | "source";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileView({
  machineId,
  root,
  rel,
  content,
  mode,
  onOpen,
  find,
  onFindStatus,
  initialScroll,
  hash = null,
  saveScroll,
  outline,
  onOutline,
  scripts = false,
}: {
  machineId: string;
  root: string;
  rel: string;
  content: FileContent;
  mode: FileMode;
  onMode(mode: FileMode): void;
  onOpen(rel: string, hash: string | null): void;
  find: FindQuery | null;
  /** Told the match count and the current match by the view that searches. */
  onFindStatus?(status: FindStatus): void;
  initialScroll: number;
  /** The `#fragment` this file was opened with by a link: `L12` shows line 12, else a heading. */
  hash?: string | null;
  saveScroll(path: string, top: number): void;
  /** Whether rendered markdown shows its outline column. */
  outline?: boolean;
  /** Told whether the rendered markdown has an outline to show. */
  onOutline?(has: boolean): void;
  /** Whether a rendered HTML page may run scripts. */
  scripts?: boolean;
}) {
  if (content.kind === "image") return <ImageView machineId={machineId} root={root} rel={rel} mtime={content.mtime} />;
  if (content.kind === "text" && content.text === null) {
    return <div className="files-notice">No content was returned for this file</div>;
  }
  if (content.kind === "binary" || content.text === null) {
    return (
      <div className="files-notice">
        <div>Binary file, not shown</div>
        <div className="files-notice-size">{formatSize(content.size)}</div>
      </div>
    );
  }
  return (
    <>
      {content.truncated && <div className="files-banner">Showing the first 2 MB</div>}
      {isMarkdown(rel) && mode === "render" ? (
        <MarkdownView
          machineId={machineId}
          root={root}
          text={content.text}
          rel={rel}
          onOpen={onOpen}
          initialScroll={initialScroll}
          initialHash={hash}
          saveScroll={saveScroll}
          outline={outline}
          onOutline={onOutline}
          find={find}
          onFindStatus={onFindStatus}
        />
      ) : isHtml(rel) && mode === "render" && !content.truncated ? (
        <HtmlView text={content.text} scripts={scripts} />
      ) : (
        <TextView
          text={content.text}
          path={rel}
          initialScroll={initialScroll}
          initialLine={lineOfHash(hash)}
          saveScroll={saveScroll}
          find={find}
          onFindStatus={onFindStatus}
        />
      )}
    </>
  );
}

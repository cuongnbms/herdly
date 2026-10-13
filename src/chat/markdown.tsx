import { createContext, useContext, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { looksLikePath, openInFiles } from "./fileLinks";
import { ChatPaneContext } from "./images";
import { MermaidBlock } from "./MermaidBlock";

/** The fenced block's language, from the `language-x` class rehype-highlight leaves on `<code>`. */
function codeLanguage(node: unknown): string | null {
  const code = (node as { children?: { properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  const cls = code?.properties?.className;
  const list = Array.isArray(cls) ? cls : [];
  const lang = list.find((c): c is string => typeof c === "string" && c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : null;
}

/** The raw text of a hast node: the fence's source, with rehype-highlight's spans flattened. */
export function nodeText(node: unknown): string {
  const n = node as { value?: unknown; children?: unknown[] } | undefined;
  if (typeof n?.value === "string") return n.value;
  return (n?.children ?? []).map(nodeText).join("");
}

export function ExternalLink({ href, children, className, title }: { href?: string; children?: ReactNode; className?: string; title?: string }) {
  const external = !!href && /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        if (external) void openUrl(href).catch((err) => console.error("openUrl failed", err));
      }}
    >
      {children}
    </a>
  );
}

/** Inline code that reads as a file path, in a Chat lens: ⌘-click opens the file as a file item in the File viewer. */
function InlineCode({ children, className }: { children?: ReactNode; className?: string }) {
  const pane = useContext(ChatPaneContext);
  const inLink = useContext(InLinkContext);
  const text = typeof children === "string" ? children : null;
  // A fenced block's text ends in a newline; inline code never does.
  if (!pane || inLink || className || text === null || !looksLikePath(text)) return <code className={className}>{children}</code>;
  return (
    <a
      href="#"
      className="chat-file-link"
      title="⌘-click to open in Files"
      onClick={(e) => {
        e.preventDefault();
        if (e.metaKey) void openInFiles(pane, text);
      }}
    >
      <code>{text}</code>
    </a>
  );
}

/** True inside a markdown link, where an image must not become a second (nested) link. */
export const InLinkContext = createContext(false);

export const mdComponents: Components = {
  pre({ node, children }) {
    const lang = codeLanguage(node);
    const source = nodeText(node).trimEnd();
    if (lang === "mermaid") return <MermaidBlock source={source}>{children}</MermaidBlock>;
    return (
      <div className="chat-code">
        <div className="chat-code-head">
          {lang ?? "code"}
          <CopyButton text={source} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  code: InlineCode,
  a({ href, children }) {
    return (
      <InLinkContext.Provider value={true}>
        <ExternalLink href={href}>{children}</ExternalLink>
      </InLinkContext.Provider>
    );
  },
  // Markdown images never become <img>: a remote one would load on render and leak to its host.
  img: function Img({ src, alt }) {
    const inLink = useContext(InLinkContext);
    const text = alt || src || "";
    if (!inLink && typeof src === "string" && /^https?:\/\//i.test(src)) {
      return (
        <ExternalLink href={src} className="chat-image-link" title={src}>
          {text}
        </ExternalLink>
      );
    }
    return <span className="chat-image-link">{text}</span>;
  },
};
export const remarkPlugins = [remarkGfm];
export const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;

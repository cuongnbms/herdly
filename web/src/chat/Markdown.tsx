import { useRef, type ComponentProps } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CopyButton } from "../ui/CopyButton";
import "./highlight.css";

type Node = ExtraProps["node"];

/** The `language-*` class on the code element inside a fenced block, else "text". */
function languageOf(node: Node): string {
  const code = node?.children.find((c) => c.type === "element");
  const classes = code?.properties?.className;
  const lang = Array.isArray(classes) ? classes.find((c) => String(c).startsWith("language-")) : undefined;
  return lang ? String(lang).slice("language-".length) : "text";
}

function CodeBlock({ node, children }: ComponentProps<"pre"> & { node?: Node }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{languageOf(node)}</span>
        <CopyButton text={() => ref.current?.textContent ?? ""} />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** No rehype-raw: HTML in a Transcript renders as text. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          pre: CodeBlock,
          table: ({ node: _node, ...props }) => <div className="table-wrap"><table {...props} /></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

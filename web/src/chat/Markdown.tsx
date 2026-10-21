import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "./highlight.css";

/** No rehype-raw: HTML in a Transcript renders as text. */
export function Markdown({ text }: { text: string }) {
  return (
    <div style={{ overflowWrap: "anywhere" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

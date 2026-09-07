import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const COMPONENTS: Components = {
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mt-4 text-lg font-bold leading-snug text-ink-900 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 text-base font-bold leading-snug text-ink-900 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 text-sm font-bold leading-snug text-ink-900 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 text-sm font-bold leading-snug text-ink-800 first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 text-[13px] font-bold leading-snug text-ink-800 first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-3 text-[13px] font-bold leading-snug text-ink-800 first:mt-0">
      {children}
    </h6>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-ink-900">{children}</strong>
  ),
  em: ({ children }) => <em>{children}</em>,
  ul: ({ children }) => <ul className="mt-2 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="mt-1 [&>ul]:pl-4 [&>ol]:pl-4">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 rounded-r-lg border-l-2 border-primary-500 bg-ink-50 px-3 py-2 text-ink-700">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-lg bg-ink-900 p-3 text-xs text-ink-100">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-ink-200" />,
  table: ({ children }) => (
    <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-ink-100 text-left">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-ink-200 px-3 py-2 font-semibold text-ink-800">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-ink-100 px-3 py-2 align-top text-ink-700">
      {children}
    </td>
  ),
  tr: ({ children }) => <tr className="last:[&>td]:border-b-0">{children}</tr>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary-700 underline underline-offset-2"
    >
      {children}
    </a>
  ),
};

interface MarkdownBodyProps {
  children: string;
  className?: string;
}

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  return (
    <div className={`text-sm leading-relaxed text-ink-700 ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { Link } from 'react-router-dom';

const KEY_RE = /(^|[\s(])([A-Z][A-Z0-9]{1,9}-\d+)(?=[\s).,;:!?]|$)/g;

/** Autolink item keys (RATES-12) that are not already inside a link. */
function autolink(md: string): string {
  return md.replace(KEY_RE, (_m, pre: string, key: string) => `${pre}[${key}](/i/${key})`);
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={'prose text-sm ' + (className ?? '')}>
      <ReactMarkdown
        urlTransform={(url) => (url.startsWith('user:') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('user:')) return <span className="mention">{children}</span>;
            if (href?.startsWith('/')) return <Link to={href}>{children}</Link>;
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {autolink(text)}
      </ReactMarkdown>
    </div>
  );
});

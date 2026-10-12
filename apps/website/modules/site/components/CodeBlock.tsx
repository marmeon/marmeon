import { useRef } from 'react';
import { CopyButton } from './CopyButton.tsx';

/**
 * A highlighted code block with a copy button (`copy={false}` leaves it out, for illustrations), in the markup the docs use: `figure.code` with a caption bar, else `div.code-block`.
 * `html` is set as markup — pass only the server's Shiki output (`createCodeHighlighter()`), never text from a user.
 */
export function CodeBlock({ html, caption, copy = true }: { html: string; caption?: string; copy?: boolean }) {
  const source = useRef<HTMLDivElement>(null);
  const block = (
    <div className="code-block">
      <div ref={copy ? source : undefined} className="code-source" dangerouslySetInnerHTML={{ __html: html }} />
      {copy && !caption && <CopyButton source={source} label="Copy code" />}
    </div>
  );
  if (!caption) return block;
  return (
    <figure className="code">
      <figcaption>
        <span className="code-caption">{caption}</span>
        {copy && <CopyButton source={source} label={`Copy ${caption}`} />}
      </figcaption>
      {block}
    </figure>
  );
}

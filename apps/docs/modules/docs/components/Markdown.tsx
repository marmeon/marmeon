import { Link } from '@marmeon/react';
import { createElement, type ReactNode } from 'react';
import type { DocNode } from '../types.ts';

/** The tags the server's renderer produces — anything else (there is nothing else) would be a `span`. */
const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'aside', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'code', 'strong', 'em', 's', 'a', 'br', 'hr']);
const PROPS: Record<string, string> = { class: 'className', tabindex: 'tabIndex' };

/**
 * A README as React elements: links to other pages are `<Link prefetch>` (a visit over the protocol, fetched ahead while the
 * pointer rests on them), anchors and external links stay `<a>`. Code blocks are the server's highlighted markup — escaped
 * text in spans, no highlighter in the browser.
 */
export function Markdown({ nodes }: { nodes: readonly DocNode[] }) {
  return <>{nodes.map(render)}</>;
}

function render(node: DocNode, key: number): ReactNode {
  if (typeof node === 'string') return node;
  if ('html' in node) return <div key={key} className="code-block" dangerouslySetInnerHTML={{ __html: node.html }} />;
  const children = (node.c ?? []).map(render);
  if (node.t === 'a' && node.a?.['data-internal'] !== undefined) {
    return (
      <Link key={key} href={node.a.href!} prefetch>
        {children}
      </Link>
    );
  }
  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.a ?? {})) props[PROPS[name] ?? name] = value;
  return createElement(TAGS.has(node.t) ? node.t : 'span', props, ...children);
}

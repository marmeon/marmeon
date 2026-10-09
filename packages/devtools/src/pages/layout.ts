import { html, raw, type Html } from '@marmeon/core';
import type { EntryType } from '../entry.ts';
import { SCRIPT, STYLE } from './assets.ts';

/** Where the pages live. */
export const BASE = '/_marmeon/devtools';

/** Each entry type's list, by its path segment. */
export const SLUGS: Readonly<Record<EntryType, string>> = {
  request: 'requests',
  query: 'queries',
  job: 'jobs',
  mail: 'mails',
  notification: 'notifications',
  log: 'logs',
  exception: 'exceptions',
  schedule: 'schedule',
  live: 'live',
  event: 'events',
  command: 'commands',
};

export const TITLES: Readonly<Record<EntryType, string>> = {
  request: 'Requests',
  query: 'Queries',
  job: 'Jobs',
  mail: 'Mails',
  notification: 'Notifications',
  log: 'Logs',
  exception: 'Exceptions',
  schedule: 'Schedule',
  live: 'Live',
  event: 'Events',
  command: 'Commands',
};

/** The entry types in the navigation's order. */
const NAV_TYPES: readonly EntryType[] = ['request', 'query', 'job', 'mail', 'notification', 'log', 'exception', 'event', 'live', 'command'];

/** A link inside the devtools: `path` under the base, with the query's set values. */
export function href(path: string, query: Readonly<Record<string, string | undefined>> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') search.set(key, value);
  const text = search.toString();
  return `${BASE}${path}${text ? `?${text}` : ''}`;
}

/** An entry's own page. */
export function entryHref(entry: { readonly type: EntryType; readonly id: string }): string {
  return `${BASE}/${SLUGS[entry.type]}/${encodeURIComponent(entry.id)}`;
}

export interface LayoutOptions {
  readonly title: string;
  /** The navigation item shown as current: an entry type, `overview`, `queue`, `schedule`. */
  readonly current?: EntryType | 'overview' | 'queue';
  /** The store's usage, for the header. */
  readonly usage?: { readonly bytes: number; readonly entries: number };
  /** Whether the app has mail previews (`/_marmeon/mail`) — linked in the navigation. */
  readonly mailPreviews?: boolean;
  /** The app's environment (`APP_ENV`, informative) — named in the header. */
  readonly environment?: string;
}

/** A whole page: header, navigation, the content, the inline style and script (both allowed by hash, `PAGE_CSP`). */
export function layout(options: LayoutOptions, content: Html): string {
  const nav = (key: LayoutOptions['current'], path: string, label: string) => html`<a href="${BASE}${path}"${options.current === key ? raw(' class="current" aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${options.title} · Devtools</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<header class="top"><a class="brand" href="${BASE}">Marmeon devtools</a><span class="dev">development only</span>${
    options.environment ? html`<span class="dev">APP_ENV=${options.environment}</span>` : ''
  }${
    options.usage ? html`<span class="usage">${options.usage.entries} entries · ${megabytes(options.usage.bytes)}</span>` : ''
  }</header>
<nav class="types" aria-label="Devtools">
${nav('overview', '', 'Overview')}
${NAV_TYPES.map((type) => nav(type, `/${SLUGS[type]}`, TITLES[type]))}
<span class="sep" aria-hidden="true"></span>
${nav('queue', '/queue', 'Queue')}
${nav('schedule', '/schedule', 'Schedule')}
${options.mailPreviews ? html`<a href="/_marmeon/mail">Mail previews</a>` : ''}
</nav>
<main>
${content}
</main>
<script>${raw(SCRIPT)}</script>
</body>
</html>`.toString();
}

/** A command to copy (E113, E130: the devtools never run one — no endpoint writes). */
export function command(text: string): Html {
  return html`<div class="command"><code>${text}</code><button type="button" data-copy="${text}" hidden>Copy</button></div>`;
}

export function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function bytesText(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** `12.3 ms`, `1.24 s`. */
export function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms >= 10 ? Math.round(ms) : Math.round(ms * 10) / 10} ms`;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** The time of day (the server's zone) with milliseconds; the full date on hover. */
export function time(at: number): Html {
  const date = new Date(at);
  return html`<time datetime="${date.toISOString()}" title="${date.toString()}">${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}</time>`;
}

/** A minute to come — the date when it is not today (the server's zone). */
export function minute(at: number): Html {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return html`<time datetime="${date.toISOString()}" title="${date.toString()}">${today ? '' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `}${pad(date.getHours())}:${pad(date.getMinutes())}</time>`;
}

/** A label of a kind: `ok`, `warn`, `bad`, `info`, `accent` or plain. */
export function badge(text: string, kind = '', title?: string): Html {
  return html`<span class="badge${kind ? ` ${kind}` : ''}"${title ? html` title="${title}"` : ''}>${text}</span>`;
}

/** Pretty JSON in a block — escaped like everything else. */
export function json(value: unknown): Html {
  if (value === undefined || value === null || (typeof value === 'object' && Object.keys(value).length === 0)) return html`<p class="empty">None.</p>`;
  return html`<pre class="block">${JSON.stringify(value, null, 2)}</pre>`;
}

/** A two-column table of labels and values (values are text or `Html`). */
export function keyValues(rows: readonly (readonly [string, unknown])[]): Html {
  const shown = rows.filter(([, value]) => value !== undefined && value !== '' && value !== null);
  if (shown.length === 0) return html`<p class="empty">None.</p>`;
  return html`<table class="kv">${shown.map(([key, value]) => html`<tr><th>${key}</th><td>${value}</td></tr>`)}</table>`;
}

/** A section with a heading. */
export function section(title: string, content: Html | string, id?: string): Html {
  return html`<section${id ? html` id="${id}"` : ''}><h2>${title}</h2>${content}</section>`;
}

/** The first line of a text, at most `max` characters. */
export function firstLine(text: string, max = 160): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

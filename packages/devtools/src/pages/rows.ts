import { html, type Html } from '@marmeon/core';
import type { AnyEntry, Entry, EntryType, RequestContent } from '../entry.ts';
import { badge, duration, entryHref, firstLine, href, time } from './layout.ts';

/**
 * The lists' rows — the same markup on a page and in the live tail (the stream sends a row the server rendered and escaped,
 * the page's script only inserts it).
 */

/** Each type's columns (the time first, a link to the entry last). */
const HEADERS: Readonly<Record<EntryType, readonly string[]>> = {
  request: ['Time', 'Method', 'Path', 'Status', 'Duration', 'Route', 'Answer'],
  query: ['Time', 'Statement', 'Duration', '', 'Origin'],
  job: ['Time', 'Job', 'Status', 'Queue', 'Attempt', 'Duration', 'Origin'],
  mail: ['Time', 'Mail', 'Subject', 'To', 'Mode', 'Origin'],
  notification: ['Time', 'Notification', 'Recipient', 'Channels', 'Outcome', 'Origin'],
  log: ['Time', 'Level', 'Message', 'Origin'],
  exception: ['Time', 'Exception', 'Message', 'Where', 'Origin'],
  schedule: ['Time', 'Task', 'Outcome', 'Reason', 'Duration'],
  live: ['Time', 'Channel', 'Props', 'Origin'],
  event: ['Time', 'Event', 'Listeners', 'Origin'],
  command: ['Time', 'Command', 'Exit', 'Duration'],
};

/** How many columns a list of `type` (or of several types) has. */
export function columnCount(type: EntryType | undefined): number {
  return type ? HEADERS[type].length : 4;
}

/** A list's table head. */
export function tableHead(type: EntryType | undefined): Html {
  const headers = type ? HEADERS[type] : ['Time', 'Type', 'Entry', 'Origin'];
  return html`<thead><tr>${headers.map((header) => html`<th>${header}</th>`)}</tr></thead>`;
}

/** One entry as a row of its type's list — or (`mixed`) of a list of several types. */
export function row(entry: AnyEntry, mixed = false): Html {
  const link = entryHref(entry);
  const at = html`<td class="time"><a class="row" href="${link}">${time(entry.at)}</a></td>`;
  if (mixed) return html`<tr>${at}<td>${badge(entry.type)}</td><td><a class="row" href="${link}">${summary(entry)}</a></td><td>${origin(entry)}</td></tr>`;
  return html`<tr>${at}${cells(entry, link)}</tr>`;
}

function cells(entry: AnyEntry, link: string): Html {
  switch (entry.type) {
    case 'request': {
      const c = entry.content;
      return html`<td class="mono">${c.method}</td><td class="mono"><a class="row" href="${link}">${readableUrl(c.url)}</a>${requestBadges(c)}</td><td>${statusBadge(c)}</td><td class="num">${duration(c.durationMs)}</td><td class="mono">${c.route ?? ''}</td><td class="mono">${c.page ? `${c.page.component}` : ''}</td>`;
    }
    case 'query': {
      const c = entry.content;
      return html`<td><a class="row sql" href="${link}">${c.sql}</a></td><td class="num">${duration(c.durationMs)}</td><td>${c.slow ? badge('slow', 'warn') : ''}${c.sensitive ? badge('secret columns', 'info', 'Parameters hidden (E125)') : ''}${c.error ? badge('failed', 'bad') : ''}</td><td>${origin(entry)}</td>`;
    }
    case 'job': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.name}</a></td><td>${jobStatus(c.status)}</td><td class="mono">${c.connection}/${c.queue}</td><td class="num">${c.attempt ?? ''}</td><td class="num">${duration(c.durationMs)}</td><td>${origin(entry)}</td>`;
    }
    case 'mail': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.mailable}</a></td><td>${c.subject ?? ''}</td><td>${c.to.join(', ')}</td><td>${badge(c.mode)}${c.error ? badge('failed', 'bad') : ''}</td><td>${origin(entry)}</td>`;
    }
    case 'notification': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.notification}</a></td><td class="mono">${c.recipient.type}#${String(c.recipient.id)}</td><td>${c.queued ? badge('queued') : (c.channels ?? []).map((channel) => badge(channel))}</td><td>${c.error ? badge('failed', 'bad') : c.outcome ? badge(c.outcome, c.outcome === 'delivered' ? 'ok' : '') : ''}</td><td>${origin(entry)}</td>`;
    }
    case 'log': {
      const c = entry.content;
      return html`<td>${levelBadge(c.level)}</td><td><a class="row" href="${link}">${firstLine(c.message, 240)}</a></td><td>${origin(entry)}</td>`;
    }
    case 'exception': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.class}</a></td><td>${firstLine(c.message, 200)}</td><td>${c.in}${c.status ? html` ${badge(String(c.status), c.status >= 500 ? 'bad' : 'warn')}` : ''}${c.path ? html` <span class="mono">${c.path}</span>` : ''}</td><td>${origin(entry)}</td>`;
    }
    case 'schedule': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.task}</a></td><td>${c.outcome ? badge(c.outcome === 'skipped' && c.skipped ? `skipped: ${c.skipped}` : c.outcome, c.outcome === 'ran' ? 'ok' : c.outcome === 'failed' ? 'bad' : '') : ''}</td><td>${c.reason}</td><td class="num">${duration(c.durationMs)}</td>`;
    }
    case 'live': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.channel}</a></td><td>${c.only === null ? html`<span class="muted">all followed</span>` : c.only.join(', ')}</td><td>${origin(entry)}</td>`;
    }
    case 'event': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">${c.name}</a></td><td>${c.listeners.length === 0 ? html`<span class="muted">none</span>` : c.listeners.join(', ')}</td><td>${origin(entry)}</td>`;
    }
    case 'command': {
      const c = entry.content;
      return html`<td class="mono"><a class="row" href="${link}">marmeon ${c.command} ${c.args.join(' ')}</a></td><td>${c.exitCode === undefined ? '' : badge(String(c.exitCode), c.exitCode === 0 ? 'ok' : 'bad')}</td><td class="num">${duration(c.durationMs)}</td>`;
    }
  }
}

/** One line about an entry of any type — for mixed lists (a batch, a request's consequences). */
export function summary(entry: AnyEntry): Html {
  switch (entry.type) {
    case 'request':
      return html`<span class="mono">${entry.content.method} ${readableUrl(entry.content.url)}</span> ${statusBadge(entry.content)}`;
    case 'query':
      return html`<span class="sql">${entry.content.sql}</span> <span class="muted">${duration(entry.content.durationMs)}</span>${entry.content.slow ? badge('slow', 'warn') : ''}`;
    case 'job':
      return html`<span class="mono">${entry.content.name}</span> ${jobStatus(entry.content.status)}${entry.content.attempt ? html` <span class="muted">attempt ${entry.content.attempt}</span>` : ''}`;
    case 'mail':
      return html`<span class="mono">${entry.content.mailable}</span> ${entry.content.subject ?? ''} ${badge(entry.content.mode)}`;
    case 'notification':
      return html`<span class="mono">${entry.content.notification}</span> → ${entry.content.recipient.type}#${String(entry.content.recipient.id)}`;
    case 'log':
      return html`${levelBadge(entry.content.level)} ${firstLine(entry.content.message, 200)}`;
    case 'exception':
      return html`${badge(entry.content.class, 'bad')} ${firstLine(entry.content.message, 200)}`;
    case 'schedule':
      return html`<span class="mono">${entry.content.task}</span> ${entry.content.outcome ?? ''}`;
    case 'live':
      return html`<span class="mono">${entry.content.channel}</span>`;
    case 'event':
      return html`<span class="mono">${entry.content.name}</span>`;
    case 'command':
      return html`<span class="mono">marmeon ${entry.content.command}</span>`;
  }
}

/** A URL as a person reads it: percent-escapes of characters decoded (`<` shows as `<` — and is escaped like all text), the origin left out. */
export function readableUrl(url: string): string {
  const path = url.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '') || '/';
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** What an entry came from: its request (also for a worker's job, E131), else its job. */
export function origin(entry: AnyEntry): Html {
  if (entry.type !== 'request' && entry.requestId) return html`<a class="mono muted" href="${href('/requests', { requestId: entry.requestId })}" title="The request it belongs to">request ${entry.requestId.slice(0, 8)}</a>`;
  if (entry.jobId && entry.type !== 'job') return html`<a class="mono muted" href="${href('/jobs', { jobId: entry.jobId })}">job ${entry.jobId.slice(0, 8)}</a>`;
  return html``;
}

/**
 * A request's status as the protocol means it: a 409 with a location is a full reload (a new build, or signing in or out —
 * the visit worked), not a failure; a redirect shows where to.
 */
export function statusBadge(content: RequestContent): Html {
  const status = content.status ?? 0;
  if (status === 409 && content.location) {
    return badge(`409 reload${content.reload ? ` (${content.reload})` : ''}`, 'info', `The protocol's full reload to ${content.location} — ${content.reload === 'version' ? 'a new build' : 'the page crossed the sign-in boundary'}; no failure`);
  }
  const kind = status >= 500 ? 'bad' : status >= 400 ? 'warn' : status >= 300 ? 'accent' : status >= 200 ? 'ok' : '';
  return badge(status === 0 ? '—' : String(status), kind, content.location ? `→ ${content.location}` : undefined);
}

/** What kind of request it was, from the protocol's headers. */
export function requestBadges(content: RequestContent): Html {
  const headers = content.headers;
  const badges: Html[] = [];
  if (content.region) badges.push(badge(content.region, 'info'));
  if (content.inProcess) badges.push(badge('in-process', '', 'Resolved in-process while its page rendered'));
  if (headers['x-marmeon-validate']) badges.push(badge('live validation', '', 'Checks fields, changes nothing (E62)'));
  else if (headers['x-marmeon-action']) badges.push(badge('action'));
  else if (headers['x-marmeon-partial-data'] || headers['x-marmeon-partial-except']) badges.push(badge('partial'));
  else if (headers['x-marmeon'] && !content.region) badges.push(badge('visit'));
  if (headers.purpose === 'prefetch' || headers['sec-purpose']?.includes('prefetch')) badges.push(badge('prefetch'));
  if (headers.accept?.includes('text/event-stream')) badges.push(badge('stream'));
  return badges.length > 0 ? html` ${badges}` : html``;
}

export function jobStatus(status: Entry<'job'>['content']['status']): Html {
  return badge(status, status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'queued' ? 'accent' : 'warn');
}

export function levelBadge(level: string): Html {
  return badge(level, level === 'error' ? 'bad' : level === 'warn' ? 'warn' : level === 'info' ? 'accent' : '');
}

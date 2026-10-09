import { html, raw, type Html } from '@marmeon/core';
import type { AnyEntry, Entry, EntryType } from '../entry.ts';
import type { EntryQuery } from '../store.ts';
import type { FailedJobView, QueueSnapshot, ScheduleSnapshot } from './infra.ts';
import {
  badge,
  BASE,
  bytesText,
  command,
  duration,
  firstLine,
  href,
  json,
  keyValues,
  minute,
  layout,
  megabytes,
  section,
  SLUGS,
  time,
  TITLES,
  type LayoutOptions,
} from './layout.ts';
import { columnCount, jobStatus, levelBadge, origin, readableUrl, requestBadges, row, statusBadge, summary, tableHead } from './rows.ts';

/** What every page shows in its frame. */
export type Frame = Pick<LayoutOptions, 'usage' | 'mailPreviews' | 'environment'>;

/** A list's filters, from its query string — what the store narrows by. */
export interface ListFilters {
  readonly search?: string;
  readonly tag?: string;
  readonly status?: string;
  readonly route?: string;
  readonly requestId?: string;
  readonly jobId?: string;
  readonly batch?: string;
  readonly before?: string;
}

/** The store query of a list. */
export function listQuery(type: EntryType | undefined, filters: ListFilters, limit: number): EntryQuery {
  const tags = [filters.tag, filters.status ? `status:${filters.status}` : undefined, filters.route ? `route:${filters.route}` : undefined].filter((tag): tag is string => !!tag);
  return {
    ...(type ? { type } : {}),
    ...(tags.length > 0 ? { tag: tags } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.requestId ? { requestId: filters.requestId } : {}),
    ...(filters.jobId ? { jobId: filters.jobId } : {}),
    ...(filters.batch ? { batch: filters.batch } : {}),
    ...(filters.before ? { before: filters.before } : {}),
    limit,
  };
}

/** The stream URL of a list's live tail: the same filters, rows rendered by the server. */
function tailUrl(type: EntryType | undefined, filters: ListFilters): string {
  const query = listQuery(type, filters, 1);
  const tags = query.tag === undefined ? [] : typeof query.tag === 'string' ? [query.tag] : query.tag;
  const search = new URLSearchParams({ rows: '1' });
  if (type) search.set('type', type);
  for (const tag of tags) search.append('tag', tag);
  for (const key of ['search', 'requestId', 'jobId', 'batch'] as const) if (filters[key]) search.set(key, filters[key]);
  return `${BASE}/stream?${search.toString()}`;
}

/** The filter form of a list (GET — it only narrows what is shown). */
function filterForm(type: EntryType | undefined, filters: ListFilters): Html {
  const statuses = ['2xx', '3xx', '4xx', '5xx', '409'];
  return html`<form class="filters" method="get" role="search">
<input type="search" name="search" value="${filters.search ?? ''}" placeholder="Search (press /)" aria-label="Search">
${
  type === 'request'
    ? html`<select name="status" data-submit aria-label="Status"><option value="">Any status</option>${statuses.map((status) => html`<option value="${status}"${filters.status === status ? raw(' selected') : ''}>${status}</option>`)}</select>
<input name="route" value="${filters.route ?? ''}" placeholder="Route name" aria-label="Route">`
    : ''
}
<input name="tag" value="${filters.tag ?? ''}" placeholder="Tag (failed, slow, job:…)" aria-label="Tag">
<input name="requestId" value="${filters.requestId ?? ''}" placeholder="Request id" aria-label="Request id">
${filters.jobId ? html`<input type="hidden" name="jobId" value="${filters.jobId}">` : ''}
${filters.batch ? html`<input type="hidden" name="batch" value="${filters.batch}">` : ''}
<button type="submit">Filter</button>
${Object.values(filters).some(Boolean) ? html`<a class="button" href="${type ? `${BASE}/${SLUGS[type]}` : BASE}">Reset</a>` : ''}
<button type="button" class="button tail" data-tail-toggle hidden><span>live</span></button>
</form>`;
}

/** A table of entries: with a live tail on the first page (new rows come in at the top). */
function entryTable(type: EntryType | undefined, entries: readonly AnyEntry[], options: { tail?: string; empty?: string } = {}): Html {
  const columns = columnCount(type);
  const rows = entries.length > 0 ? entries.map((entry) => row(entry, type === undefined)) : html`<tr data-empty><td colspan="${columns}" class="muted">${options.empty ?? 'Nothing recorded yet.'}</td></tr>`;
  return html`<table>${tableHead(type)}<tbody${options.tail ? html` data-tail="${options.tail}"` : ''}>${rows}</tbody></table>`;
}

/** `/_marmeon/devtools/<type>`: the newest entries of a type, filtered, searchable, paged, live. */
export function listPage(frame: Frame, type: EntryType, entries: readonly AnyEntry[], filters: ListFilters, limit: number, extra?: Html): string {
  const next = entries.length === limit ? entries.at(-1)?.id : undefined;
  const live = filters.before === undefined;
  const scope = [
    filters.requestId ? html` of request <code>${filters.requestId}</code>` : '',
    filters.jobId ? html` of job <code>${filters.jobId}</code>` : '',
    filters.batch ? html` of batch <code>${filters.batch}</code>` : '',
  ];
  return layout(
    { ...frame, title: TITLES[type], current: type },
    html`<h1>${TITLES[type]}</h1>
<p class="sub">Newest first${scope}. ${filters.before ? html`<a href="${href(`/${SLUGS[type]}`, { ...filters, before: undefined })}">Back to the newest</a>` : 'New entries appear at the top while live.'}</p>
${extra ?? ''}
<section>
${filterForm(type, filters)}
${entryTable(type, entries, live ? { tail: tailUrl(type, filters) } : {})}
${next ? html`<p class="pager"><a href="${href(`/${SLUGS[type]}`, { ...filters, before: next })}">Older →</a></p>` : ''}
</section>`,
  );
}

export interface OverviewData {
  readonly requests: readonly AnyEntry[];
  readonly exceptions: readonly AnyEntry[];
  readonly slowQueries: readonly AnyEntry[];
  readonly failedJobs: readonly AnyEntry[];
  readonly queue: QueueSnapshot;
  readonly schedule: ScheduleSnapshot;
  readonly warnings: readonly string[];
  readonly usage: { readonly bytes: number; readonly files: number; readonly entries: number };
  readonly maxBytes?: number;
}

/** `/_marmeon/devtools`: what happened lately, and what needs a look. */
export function overviewPage(frame: Frame, data: OverviewData): string {
  const queueSummary = queueStats(data.queue);
  return layout(
    { ...frame, title: 'Overview', current: 'overview' },
    html`<h1>Overview</h1>
<p class="sub">What the app did lately — every process of it (server, worker, scheduler) writes here. Development only; everything shown is redacted.</p>
${data.warnings.map((warning) => html`<div class="callout warn" role="note"><p>${warning}</p></div>`)}
<section><span class="stat"><b>${data.usage.entries}</b>entries</span><span class="stat"><b>${megabytes(data.usage.bytes)}</b>${data.maxBytes ? `of ${megabytes(data.maxBytes)}` : 'stored'}</span><span class="stat"><b>${data.usage.files}</b>files</span>${queueSummary}</section>
${section('Latest requests', html`${entryTable('request', data.requests, { tail: tailUrl('request', {}) })}<p class="pager"><a href="${BASE}/requests">All requests →</a></p>`)}
<div class="grid">
${section('Exceptions', html`${entryTable('exception', data.exceptions, { empty: 'No exceptions.' })}<p class="pager"><a href="${BASE}/exceptions">All exceptions →</a></p>`)}
${section('Slow queries', html`${entryTable('query', data.slowQueries, { empty: 'No slow queries.' })}<p class="pager"><a href="${href('/queries', { tag: 'slow' })}">All slow queries →</a></p>`)}
${section('Failed job attempts', html`${entryTable('job', data.failedJobs, { empty: 'No failed attempts.' })}<p class="pager"><a href="${BASE}/queue">Queue →</a></p>`)}
</div>`,
  );
}

function queueStats(queue: QueueSnapshot): Html {
  if (!queue.available) return html``;
  const waiting = queue.connections.reduce((sum, connection) => sum + connection.queues.reduce((total, q) => total + q.size, 0), 0);
  return html`<span class="stat"><b>${waiting}</b><a href="${BASE}/queue">jobs queued</a></span><span class="stat"><b>${queue.failedTotal}</b><a href="${BASE}/queue#failed">failed jobs</a></span>`;
}

/** `/_marmeon/devtools/queue`: the queues now, the failed jobs, and the latest attempts (E113). */
export function queuePage(frame: Frame, queue: QueueSnapshot, attempts: readonly AnyEntry[]): string {
  let body: Html;
  if (!queue.available) {
    body = html`<div class="callout info"><p>${queue.reason}</p></div>`;
  } else {
    body = html`${queue.connections.length === 0 ? html`<div class="callout info"><p>The queue runs every job when it is dispatched (sync) — nothing waits.</p></div>` : ''}
${queue.connections.map(
  (connection) => html`<section><h2>${connection.connection} <span class="badge">${connection.driver}</span>${connection.connection === queue.default ? html` <span class="badge accent">default</span>` : ''}</h2>
${
  connection.error
    ? html`<p class="muted">Could not read it: ${connection.error}</p>`
    : html`<table><thead><tr><th>Queue</th><th class="num">Jobs</th><th class="num">Ready</th><th class="num">Delayed</th><th class="num">Running</th></tr></thead><tbody>${connection.queues.map(
        (q) => html`<tr><td class="mono">${q.name}</td><td class="num">${q.size}</td><td class="num">${q.ready ?? ''}</td><td class="num">${q.delayed ?? ''}</td><td class="num">${q.reserved ?? ''}</td></tr>`,
      )}</tbody></table>`
}
${command(`marmeon queue:size --connection=${connection.connection}`)}
</section>`,
)}
<section id="failed"><h2>Failed jobs (${queue.failedTotal})</h2>
${queue.failedError ? html`<p class="muted">Could not read them: ${queue.failedError}</p>` : queue.failed.length === 0 ? html`<p class="empty">No failed jobs.</p>` : queue.failed.map(failedJob)}
${queue.failedTotal > 0 ? html`<h3>All of them</h3>${command('marmeon queue:retry all')}${command('marmeon queue:flush')}` : ''}
</section>`;
  }
  return layout(
    { ...frame, title: 'Queue', current: 'queue' },
    html`<h1>Queue</h1>
<p class="sub">The queues as they are now, read through the queue's own connections. Nothing here changes them — copy a command into a terminal.</p>
${body}
${section('Latest attempts', html`${entryTable('job', attempts, { tail: tailUrl('job', {}), empty: 'No job ran yet.' })}<p class="pager"><a href="${BASE}/jobs">All job entries →</a></p>`)}`,
  );
}

function failedJob(job: FailedJobView): Html {
  return html`<details><summary><span class="mono">${job.job}</span> ${badge(`${job.connection}/${job.queue}`)} <span class="muted">${time(job.failedAt)}</span> — ${firstLine(job.exception, 140)}</summary>
${keyValues([
  ['Id', html`<code>${job.id}</code> · <a href="${href('/jobs', { jobId: job.id })}">its entries</a>`],
  ['Request', job.requestId ? html`<a href="${href('/requests', { requestId: job.requestId })}"><code>${job.requestId}</code></a>` : undefined],
])}
<h3>Error</h3><pre class="block">${job.exception}</pre>
<h3>Payload</h3>${json(job.payload)}
<h3>Commands</h3>${command(job.retry)}${command(job.forget)}
</details>`;
}

/** `/_marmeon/devtools/schedule`: the tasks with their next run, the lock warning (E123), and the latest runs. */
export function schedulePage(frame: Frame, schedule: ScheduleSnapshot, entries: readonly AnyEntry[], filters: ListFilters, limit: number): string {
  const tasks = !schedule.available
    ? html`<div class="callout info"><p>${schedule.reason}</p></div>`
    : html`${schedule.warning ? html`<div class="callout warn" role="note"><p>${schedule.warning}</p></div>` : ''}
<section><h2>Tasks</h2>${
        schedule.tasks.length === 0
          ? html`<p class="empty">No scheduled tasks — a module adds them with defineModule({ schedule: defineSchedule((s) => { … }) }).</p>`
          : html`<table><thead><tr><th>Task</th><th>Schedule</th><th>Next run</th><th class="hide-sm">Does</th><th>Options</th><th>Run it now</th></tr></thead><tbody>${schedule.tasks.map(
              (task) =>
                html`<tr><td class="mono"><a href="${href('/schedule', { tag: `task:${task.name}` })}">${task.name}</a></td><td class="mono">${task.expression} <span class="muted">(${task.timeZone})</span></td><td>${task.next === undefined ? '—' : minute(task.next)}</td><td class="mono hide-sm">${task.summary}</td><td>${task.options.map((option) => badge(option))}</td><td>${command(task.test)}</td></tr>`,
            )}</tbody></table>${command('marmeon schedule:list')}`
      }</section>`;
  return listPage(frame, 'schedule', entries, filters, limit, tasks);
}

/** An entry's own page: what it is, where it belongs, its content. */
export function entryPage(frame: Frame, entry: AnyEntry, related: { batch: readonly AnyEntry[]; triggered: readonly AnyEntry[] }): string {
  const title = `${TITLES[entry.type].replace(/s$/, '')}: ${plainTitle(entry)}`;
  return layout(
    { ...frame, title, current: entry.type },
    html`<p class="sub"><a href="${BASE}/${SLUGS[entry.type]}">← ${TITLES[entry.type]}</a></p>
<h1>${headline(entry)}</h1>
<p class="sub">${time(entry.at)} · ${entry.tags.map((tag) => html`<a href="${href(`/${SLUGS[entry.type]}`, { tag })}">${badge(tag)}</a>`)}</p>
${detail(entry)}
${section(
  'Where it belongs',
  keyValues([
    ['Batch', html`<a href="${href(`/batches/${encodeURIComponent(entry.batch)}`)}"><code>${entry.batch}</code></a> <span class="muted">(${related.batch.length} entries)</span>`],
    ['Request', entry.requestId ? html`<a href="${href('/requests', { requestId: entry.requestId })}"><code>${entry.requestId}</code></a>` : undefined],
    ['Job', entry.jobId ? html`<a href="${href('/jobs', { jobId: entry.jobId })}"><code>${entry.jobId}</code></a>` : undefined],
    ['Entry', html`<code>${entry.id}</code> · <a href="${href(`/api/entries/${encodeURIComponent(entry.id)}`)}">JSON</a>`],
  ]),
)}
${entry.type === 'request' ? requestRelated(entry, related) : related.batch.length > 1 ? section('In the same batch', entryTable(undefined, related.batch)) : ''}
${section('Recorded', json(entry.content))}`,
  );
}

/** `/_marmeon/devtools/batches/:batch`: everything one request, job attempt, run or command recorded, in order. */
export function batchPage(frame: Frame, batch: string, entries: readonly AnyEntry[]): string {
  return layout(
    { ...frame, title: `Batch ${batch}` },
    html`<h1>Batch <code>${batch}</code></h1>
<p class="sub">What one request (with what it resolved in-process), job attempt, scheduled run or command recorded — in order.</p>
${section(`${entries.length} entries`, entryTable(undefined, entries, { empty: 'No entries — the batch is gone (the ring keeps 24 hours) or never was.' }))}`,
  );
}

/** A request's own sections: what it did itself, what it set off (jobs in a worker, their mails — E131). */
function requestRelated(entry: Entry<'request'>, related: { batch: readonly AnyEntry[]; triggered: readonly AnyEntry[] }): Html {
  const own = related.batch.filter((candidate) => candidate.id !== entry.id);
  const byType = (type: EntryType) => own.filter((candidate) => candidate.type === type);
  const queries = byType('query');
  const queryMs = queries.reduce((sum, query) => sum + (query.type === 'query' ? query.content.durationMs : 0), 0);
  const groups = new Map<string, AnyEntry[]>();
  for (const candidate of related.triggered) groups.set(candidate.batch, [...(groups.get(candidate.batch) ?? []), candidate]);
  return html`${section(`Queries (${queries.length}, ${duration(queryMs)})`, entryTable('query', queries, { empty: 'No queries.' }), 'queries')}
${section(`Log (${byType('log').length})`, entryTable('log', byType('log'), { empty: 'Nothing logged.' }), 'logs')}
${section(
  `Also in this request (${own.length - queries.length - byType('log').length})`,
  entryTable(
    undefined,
    own.filter((candidate) => candidate.type !== 'query' && candidate.type !== 'log'),
    { empty: 'Nothing else: no jobs queued, mails, events, live hints or exceptions.' },
  ),
)}
${section(
  'What it set off',
  groups.size === 0
    ? html`<p class="empty">Nothing ran later for it — no job of this request has run (yet).</p>`
    : html`${[...groups].map(([batch, entries]) => html`<h3><a href="${href(`/batches/${encodeURIComponent(batch)}`)}">${batchTitle(entries)}</a></h3>${entryTable(undefined, entries)}`)}`,
  'triggered',
)}`;
}

function batchTitle(entries: readonly AnyEntry[]): string {
  const job = entries.find((candidate) => candidate.type === 'job' && candidate.content.status !== 'queued');
  if (job?.type === 'job') return `Job ${job.content.name} — attempt ${job.content.attempt ?? '?'}, ${job.content.status}`;
  const request = entries.find((candidate) => candidate.type === 'request');
  if (request?.type === 'request') return `Request ${request.content.method} ${readableUrl(request.content.url)}`;
  return `Batch ${entries[0]?.batch ?? ''}`;
}

/** The heading of an entry's page. */
function headline(entry: AnyEntry): Html {
  switch (entry.type) {
    case 'request':
      return html`<span class="mono">${entry.content.method} ${readableUrl(entry.content.url)}</span> ${statusBadge(entry.content)}${requestBadges(entry.content)}`;
    case 'exception':
      return html`<span class="mono">${entry.content.class}</span>: ${firstLine(entry.content.message, 300)}`;
    default:
      return summary(entry);
  }
}

function plainTitle(entry: AnyEntry): string {
  switch (entry.type) {
    case 'request':
      return `${entry.content.method} ${entry.content.path}`;
    case 'query':
      return firstLine(entry.content.sql, 60);
    case 'job':
      return entry.content.name;
    case 'mail':
      return entry.content.mailable;
    case 'notification':
      return entry.content.notification;
    case 'log':
      return firstLine(entry.content.message, 60);
    case 'exception':
      return entry.content.class;
    case 'schedule':
      return entry.content.task;
    case 'live':
      return entry.content.channel;
    case 'event':
      return entry.content.name;
    case 'command':
      return entry.content.command;
  }
}

/** The type's own presentation of an entry, above the raw content. */
function detail(entry: AnyEntry): Html {
  switch (entry.type) {
    case 'request': {
      const c = entry.content;
      const props = c.page ? Object.entries(c.page.props).sort((a, b) => b[1] - a[1]) : [];
      const largest = props[0]?.[1] ?? 1;
      return html`${
        c.status === 409 && c.location
          ? html`<div class="callout info" role="note"><p><b>409 is the protocol's full reload, not a failure:</b> ${c.reload === 'version' ? 'the page was built from an older version of the app' : 'the request signed in or out, so no page kept in memory may outlive it'} — the browser loads <code>${c.location}</code> fully.</p></div>`
          : ''
      }
${section(
  'Request',
  keyValues([
    ['Status', statusBadge(c)],
    ['Duration', duration(c.durationMs)],
    ['Route', c.route ? html`<code>${c.route}</code>` : undefined],
    ['URL', html`<code>${c.url}</code>`],
    ['Pattern', c.routePath ? html`<code>${c.routePath}</code>` : undefined],
    ['Controller', c.controller ? html`<code>${c.controller}</code>` : undefined],
    ['Location', c.location ? html`<code>${c.location}</code>` : undefined],
    ['Server rendering', c.ssr ? html`<code>${c.ssr.component}</code> ${duration(c.ssr.durationMs)} ${c.ssr.streamed ? badge('streamed') : ''}${c.ssr.failed ? badge('failed', 'bad') : ''}` : undefined],
    ['Not kept', c.dropped ? `${c.dropped} entries over the batch limit` : undefined],
  ]),
)}
${
  c.page
    ? section(
        `Page: ${c.page.component} (${c.page.kind}, ${bytesText(c.page.bytes)})`,
        html`${c.page.only ? html`<p>Partial reload — only ${c.page.only.map((key) => badge(key, 'accent'))}</p>` : ''}${c.page.except ? html`<p>Except ${c.page.except.map((key) => badge(key))}</p>` : ''}${
          c.page.deferred ? html`<p>Deferred: ${Object.entries(c.page.deferred).map(([group, keys]) => html`${badge(group, 'info')} ${keys.join(', ')} `)}</p>` : ''
        }<table class="props"><thead><tr><th>Prop</th><th class="num">Size</th><th></th></tr></thead><tbody>${props.map(
          ([key, bytes]) => html`<tr><td class="mono">${key}</td><td class="num">${bytesText(bytes)}</td><td class="bar"><meter min="0" max="${largest}" value="${bytes}"></meter></td></tr>`,
        )}</tbody></table><p class="muted">Sizes of each prop's JSON — never their values.</p>`,
        'page',
      )
    : ''
}
${c.error ? section('Error', html`<p><b>${c.error.class}</b>: ${c.error.message}</p>${c.error.stack ? html`<pre class="block">${c.error.stack}</pre>` : ''}`) : ''}
${section('Headers', keyValues(Object.entries(c.headers).map(([key, value]) => [key, html`<span class="mono">${value}</span>`])))}
${section('Query', json(c.query))}
${section('Input', c.input === undefined ? html`<p class="empty">The app read no body.</p>` : json(c.input))}`;
    }
    case 'query':
      return section(
        'Statement',
        html`<pre class="block">${entry.content.sql}</pre><h3>Parameters</h3>${entry.content.sensitive ? html`<p>${badge('secret columns', 'info')} The statement touches a table with secret columns — no parameter is kept.</p>` : json(entry.content.parameters)}${keyValues([
          ['Duration', duration(entry.content.durationMs)],
          ['Connection', `${entry.content.connection} (${entry.content.driver})`],
          ['Error', entry.content.error ? `${entry.content.error.class}: ${entry.content.error.message}` : undefined],
        ])}`,
      );
    case 'job':
      return html`${section(
        'Job',
        keyValues([
          ['Status', jobStatus(entry.content.status)],
          ['Queue', `${entry.content.connection}/${entry.content.queue}`],
          ['Attempt', entry.content.attempt],
          ['Dispatched as', entry.content.kind],
          ['Delay', entry.content.delay ? `${entry.content.delay} s` : undefined],
          ['Unique', entry.content.unique],
          ['Duration', duration(entry.content.durationMs)],
          ['All its entries', entry.jobId ? html`<a href="${href('/jobs', { jobId: entry.jobId })}">dispatch and attempts</a>` : undefined],
        ]),
      )}${entry.content.error ? section('Error', html`<p><b>${entry.content.error.class}</b>: ${entry.content.error.message}</p>${entry.content.error.stack ? html`<pre class="block">${entry.content.error.stack}</pre>` : ''}`) : ''}${section('Payload', json(entry.content.payload))}${
        entry.content.status === 'failed' && entry.jobId ? section('Retry it', html`<p class="muted">After its last attempt it is in the failed jobs:</p>${command(`marmeon queue:retry ${entry.jobId}`)}`) : ''
      }`;
    case 'mail':
      return html`${section(
        'Mail',
        keyValues([
          ['Subject', entry.content.subject],
          ['From', entry.content.from],
          ['To', entry.content.to.join(', ')],
          ['Cc', entry.content.cc.join(', ')],
          ['Bcc', entry.content.bcc.join(', ')],
          ['Mode', entry.content.mode],
          ['Attachments', entry.content.attachments.map((attachment) => `${attachment.filename} (${bytesText(attachment.bytes)})`).join(', ')],
          ['Error', entry.content.error ? `${entry.content.error.class}: ${entry.content.error.message}` : undefined],
        ]),
      )}${
        entry.content.html
          ? section(
              'HTML',
              html`<p class="muted">In a sandboxed frame: no script of the mail runs, it cannot reach this page (links with tokens are masked).</p><iframe class="mail" sandbox src="${BASE}/mails/${encodeURIComponent(entry.id)}/html" title="${entry.content.subject ?? 'The mail'}" referrerpolicy="no-referrer"></iframe>`,
            )
          : ''
      }${entry.content.text ? section('Text', html`<pre class="block">${entry.content.text}</pre>`) : ''}`;
    case 'exception':
      return html`${entry.content.solutions.map(
        (solution) => html`<div class="callout info"><p><b>${solution.title}</b></p><p>${solution.text}</p>${solution.command ? command(solution.command) : ''}${solution.docs ? html`<p class="muted">Docs: <code>${solution.docs}</code></p>` : ''}</div>`,
      )}${section(
        'Where',
        keyValues([
          ['In', entry.content.in],
          ['Status', entry.content.status],
          ['Request', entry.content.method ? html`<code>${entry.content.method} ${entry.content.path ?? ''}</code>` : undefined],
        ]),
      )}${entry.content.stack ? section('Stack', html`<pre class="block">${entry.content.stack}</pre>`) : ''}`;
    case 'log':
      return section('Message', html`<p>${levelBadge(entry.content.level)}</p><pre class="block">${entry.content.message}</pre><h3>Context</h3>${json(entry.content.context)}`);
    case 'schedule':
      return section(
        'Run',
        keyValues([
          ['Task', html`<code>${entry.content.task}</code>`],
          ['Due', time(entry.content.minute)],
          ['Reason', entry.content.reason],
          ['Outcome', entry.content.outcome],
          ['Skipped', entry.content.skipped],
          ['Duration', duration(entry.content.durationMs)],
          ['Error', entry.content.error ? `${entry.content.error.class}: ${entry.content.error.message}` : undefined],
          ['Run it now', command(`marmeon schedule:test ${entry.content.task}`)],
        ]),
      );
    case 'command':
      return section(
        'Command',
        keyValues([
          ['Command line', html`<code>marmeon ${entry.content.command} ${entry.content.args.join(' ')}</code>`],
          ['Exit code', entry.content.exitCode],
          ['Duration', duration(entry.content.durationMs)],
          ['Error', entry.content.error ? `${entry.content.error.class}: ${entry.content.error.message}` : undefined],
        ]),
      );
    case 'notification':
    case 'live':
    case 'event':
      return html`<p>${origin(entry)}</p>`;
  }
}

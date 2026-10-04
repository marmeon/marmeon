import { createHash } from 'node:crypto';
import { reportMarkdown } from './markdown.ts';
import { editorLink, type ErrorReport, type StackFrame } from './report.ts';

/**
 * The development error page (E119): one self-contained HTML document — its own CSS (light and dark after the system),
 * no React, no Vite, no client code of the app — so it renders when server rendering or the build is what broke, and in
 * the sandboxed frame a client-side visit shows it in (`VisitFailure`, no scripts there). It works without JavaScript:
 * sections are `<details>`, the Markdown is in a text field; one small inline script only adds the copy button.
 *
 * Everything it shows comes from the redacted {@link ErrorReport} (E125) and is escaped here.
 */
export function renderErrorPage(report: ErrorReport): string {
  const { error, status, request, route } = report;
  const markdown = reportMarkdown(report);
  // The first frame with code — the app's own, when there is one — is open.
  const opened = report.frames.find((frame) => frame.app && frame.snippet) ?? report.frames.find((frame) => frame.snippet);
  const nav = [
    ['stack', `Stack`],
    ['request', 'Request'],
    ...(route ? [['route', 'Route']] : []),
    ['queries', `Queries (${report.queries.length + report.droppedQueries})`],
    ['logs', `Log (${report.logs.length + report.droppedLogs})`],
    ...(report.warnings.length > 0 ? [['warnings', `Warnings (${report.warnings.length})`]] : []),
    ['environment', 'Environment'],
    ['markdown', 'Markdown'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(`${error.name}: ${firstLine(error.message)}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="head">
  <p class="eyebrow"><span class="status">${status}</span> <span class="class">${escape(error.name)}</span> <span class="dev">development only</span></p>
  <h1>${escape(error.message)}</h1>
  ${report.causes.map((cause) => `<p class="cause">Caused by <b>${escape(cause.name)}</b>: ${escape(cause.message)}</p>`).join('')}
  <p class="where"><code>${escape(request.method)} ${escape(request.url)}</code>${route?.name ? ` · <code>${escape(route.name)}</code>` : ''}${route?.controller ? ` · <code>${escape(route.controller)}</code>` : ''}${report.requestId ? ` · request <code>${escape(report.requestId)}</code>` : ''}</p>
</header>
${report.solutions.length > 0 ? `<section class="solutions" aria-label="Solutions">${report.solutions.map(solutionHtml).join('')}</section>` : ''}
<nav aria-label="Sections">${nav.map(([id, label]) => `<a href="#${id}">${escape(label!)}</a>`).join('')}<button type="button" class="copy" data-copy="bespoke-markdown" hidden>Copy as Markdown</button></nav>

<section id="stack">
  <h2>Stack</h2>
  ${report.frames.length === 0 ? '<p class="muted">No stack.</p>' : ''}
  ${stackHtml(report.frames, opened)}
</section>

<section id="request">
  <h2>Request</h2>
  ${table([
    ['Method', request.method],
    ['URL', request.url],
  ])}
  <h3>Headers</h3>
  ${table(Object.entries(request.headers))}
  <h3>Query</h3>
  ${json(request.query)}
  <h3>Body</h3>
  ${json(request.body)}
</section>

${
  route
    ? `<section id="route">
  <h2>Route</h2>
  ${table([
    ['Name', route.name ?? '(unnamed)'],
    ['Path', route.path],
    ['Methods', route.methods.join(', ')],
    ['Controller', route.controller ?? '(a closure)'],
    ['Middleware', route.middleware.join(' → ') || '(none)'],
  ])}
  <h3>Parameters</h3>
  ${json(route.params)}
</section>`
    : ''
}

<section id="queries">
  <h2>Queries</h2>
  ${
    report.queries.length === 0
      ? '<p class="muted">No queries in this request.</p>'
      : `<ol class="queries">${report.queries
          .map(
            (query) =>
              `<li><pre><code>${escape(query.sql)}</code></pre><p class="meta">${round(query.durationMs)} ms${query.connection === 'default' ? '' : ` · ${escape(query.connection)}`}${
                query.parameters.length > 0 ? ` · <code>${escape(JSON.stringify(query.parameters))}</code>` : ''
              }${query.secret ? ' · <span class="badge">secret columns: parameters hidden</span>' : ''}</p></li>`,
          )
          .join('')}</ol>${report.droppedQueries > 0 ? `<p class="muted">… and ${report.droppedQueries} more (the first 100 are shown).</p>` : ''}`
  }
</section>

<section id="logs">
  <h2>Log</h2>
  ${
    report.logs.length === 0
      ? '<p class="muted">Nothing logged in this request.</p>'
      : `<ul class="logs">${report.logs
          .map((entry) => `<li class="level-${escape(entry.level)}"><span class="badge">${escape(entry.level)}</span> ${escape(entry.message)}${isEmpty(entry.context) ? '' : `<pre><code>${escape(JSON.stringify(entry.context, null, 2))}</code></pre>`}</li>`)
          .join('')}</ul>${report.droppedLogs > 0 ? `<p class="muted">… and ${report.droppedLogs} more.</p>` : ''}`
  }
</section>

${
  report.warnings.length > 0
    ? `<section id="warnings">
  <h2>Injection warnings</h2>
  <ul class="warnings">${report.warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>
</section>`
    : ''
}

<section id="environment">
  <h2>Environment</h2>
  ${table([
    ['Node', report.environment.node],
    ['NODE_ENV', report.environment.nodeEnv ?? '(unset)'],
    ['Platform', report.environment.platform],
    ['App', report.environment.app ?? ''],
    ['BespokeCore', report.environment.packages.map((entry) => `${entry.name}${entry.version ? `@${entry.version}` : ''}`).join(', ') || '(no packages discovered)'],
  ])}
</section>

<section id="markdown">
  <h2>Markdown</h2>
  <p class="muted">The report for an issue or a chat — redacted like this page. Select it and copy, or use the button above.</p>
  <textarea id="bespoke-markdown" readonly rows="14" spellcheck="false">${escape(markdown)}</textarea>
</section>
<iframe name="bespoke-editor" title="Opens files in your editor" hidden></iframe>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function solutionHtml(solution: ErrorReport['solutions'][number]): string {
  return `<article class="solution">
  <h2>${escape(solution.title)}</h2>
  <p>${escape(solution.text)}</p>
  ${solution.command ? `<pre class="command"><code>${escape(solution.command)}</code></pre>` : ''}
  ${solution.docs ? `<p class="docs">Docs: <code>${escape(solution.docs)}</code></p>` : ''}
</article>`;
}

/**
 * The frames in their order — the app's own at the top level, every run of framework, package and Node frames between them
 * folded into one line ("4 framework frames"), so the app's frames are what the eye finds first.
 */
function stackHtml(frames: readonly StackFrame[], opened: StackFrame | undefined): string {
  const out: string[] = [];
  let run: StackFrame[] = [];
  const flush = () => {
    if (run.length === 0) return;
    // A run that holds the frame to show (no app frame at all) stays open.
    const open = opened !== undefined && run.includes(opened);
    out.push(
      `<details class="vendor-frames"${open ? ' open' : ''}><summary>${run.length} framework frame${run.length === 1 ? '' : 's'}</summary>${run.map((frame) => frameHtml(frame, frame === opened)).join('')}</details>`,
    );
    run = [];
  };
  for (const frame of frames) {
    if (frame.app) {
      flush();
      out.push(frameHtml(frame, frame === opened));
    } else {
      run.push(frame);
    }
  }
  flush();
  return out.join('\n');
}

function frameHtml(frame: StackFrame, open: boolean): string {
  const label = `${frame.fn ? `<b>${escape(frame.fn)}</b> ` : ''}<span class="file">${escape(frame.display)}:${frame.line}:${frame.column}</span>`;
  const editor = frame.internal ? '' : ` <a class="editor" href="${escape(editorLink(frame))}" target="bespoke-editor">open in editor</a>`;
  const kind = frame.app ? 'app' : frame.internal ? 'internal' : 'vendor';
  if (!frame.snippet) return `<div class="frame ${kind}">${label}${editor}</div>`;
  const code = frame.snippet
    .map((line) => `<span class="line${line.current ? ' current' : ''}"><span class="number">${line.number}</span>${escape(line.text) || ' '}</span>`)
    .join('');
  return `<details class="frame ${kind}"${open ? ' open' : ''}><summary>${label}${editor}</summary><pre class="snippet"><code>${code}</code></pre></details>`;
}

function table(rows: readonly (readonly [string, string])[]): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  return `<table>${rows.map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(value)}</td></tr>`).join('')}</table>`;
}

function json(value: unknown): string {
  return isEmpty(value) ? '<p class="muted">None.</p>' : `<pre><code>${escape(JSON.stringify(value, null, 2))}</code></pre>`;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && Object.keys(value).length === 0);
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.slice(0, 160);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** HTML-escapes text for element content and quoted attributes. */
export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// The copy button — the only script. In the visit dialog's sandboxed frame it does not run: the text field stays.
const SCRIPT = `for (const button of document.querySelectorAll('[data-copy]')) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).value);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed — select the text below';
    }
  });
}`;

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--panel:#fff;--text:#1c1f24;--muted:#646b76;--border:#e3e3df;--accent:#b4361b;--accent-soft:#fbeee9;--solution:#155e46;--solution-soft:#e8f4ee;--code:#f1f1ee;--current:#fde9a8;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121314;--panel:#1a1c1e;--text:#e7e8e9;--muted:#9a9fa6;--border:#2c2f33;--accent:#f07a5a;--accent-soft:#2b1b16;--solution:#6fd3a8;--solution-soft:#14261f;--code:#151618;--current:#4a3d12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}
code,pre,textarea{font-family:var(--mono);font-size:13px}
.head{padding:8px 0 20px;border-bottom:1px solid var(--border)}
.eyebrow{margin:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.status{background:var(--accent);color:#fff;border-radius:4px;padding:1px 8px;font-weight:600}
.class{font-family:var(--mono);color:var(--accent);font-weight:600}
.dev{margin-left:auto;font-size:12px}
h1{font-size:22px;line-height:1.35;margin:10px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}
h2{font-size:17px;margin:0 0 12px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:20px 0 8px}
.cause{margin:4px 0;color:var(--muted)}
.where{margin:8px 0 0;color:var(--muted);overflow-wrap:anywhere}
.solutions{display:grid;gap:12px;margin:20px 0}
.solution{background:var(--solution-soft);border:1px solid color-mix(in srgb,var(--solution) 35%,transparent);border-radius:8px;padding:14px 16px}
.solution h2{color:var(--solution);margin:0 0 6px}
.solution p{margin:0 0 8px}
.command{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin:8px 0 0;user-select:all}
.docs{font-size:13px;color:var(--muted)}
nav{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;background:var(--bg);padding:10px 0;margin:8px 0 16px;border-bottom:1px solid var(--border)}
nav a{color:var(--text);text-decoration:none;font-size:14px}
nav a:hover{color:var(--accent)}
.copy{margin-left:auto;font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer}
section{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:16px;margin:0 0 16px;overflow:hidden}
.frame{border-top:1px solid var(--border);padding:6px 0;font-size:13px;overflow-wrap:anywhere}
.frame:first-of-type{border-top:0}
.vendor-frames{border-top:1px solid var(--border);padding:6px 0;font-size:13px;color:var(--muted)}
.vendor-frames:first-of-type{border-top:0}
.vendor-frames>summary{cursor:pointer}
.vendor-frames .frame{padding-left:16px}
.frame.vendor,.frame.internal{color:var(--muted)}
.frame summary{cursor:pointer}
.file{font-family:var(--mono)}
.editor{margin-left:8px;font-size:12px;color:var(--accent)}
.snippet{background:var(--code);border-radius:6px;padding:8px 0;margin:8px 0;overflow-x:auto}
.line{display:block;padding:0 12px;white-space:pre}
.line.current{background:var(--current)}
.number{display:inline-block;width:3.5em;color:var(--muted);user-select:none}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
section>pre,.queries pre,.logs pre{background:var(--code);border-radius:6px;padding:8px 12px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:4px 8px;border-top:1px solid var(--border);overflow-wrap:anywhere}
th{width:22%;font-weight:600;color:var(--muted)}
.queries,.logs,.warnings{margin:0;padding-left:20px}
.queries li,.logs li,.warnings li{margin:0 0 10px}
.meta{margin:4px 0 0;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.badge{display:inline-block;font-size:11px;border:1px solid var(--border);border-radius:4px;padding:0 6px;color:var(--muted)}
.level-error .badge,.level-warn .badge{color:var(--accent);border-color:var(--accent)}
.muted{color:var(--muted);margin:0}
textarea{width:100%;background:var(--code);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:10px;resize:vertical}
`;

const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`;

/**
 * The error page's own Content-Security-Policy: its inline style and script by hash, nothing else runs — and an app's
 * `contentSecurityPolicy()` leaves a response with a policy of its own alone (its nonce would not cover these). Editor links
 * open in a frame of this origin.
 */
export const ERROR_PAGE_CSP = [
  "default-src 'none'",
  `style-src ${hash(STYLE)}`,
  `script-src ${hash(SCRIPT)}`,
  "img-src 'self' data:",
  "frame-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

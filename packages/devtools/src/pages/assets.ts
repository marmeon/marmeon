import { createHash } from 'node:crypto';

/**
 * The pages' only script (E117: no client framework, nothing of it in the app's bundle): the live tail (an `EventSource` on
 * `/_bespoke/devtools/stream`, rows rendered and escaped by the server), filters that submit on change, copy buttons for
 * commands. The pages work without it — lists reload, commands can be selected.
 */
export const SCRIPT = `(() => {
  for (const select of document.querySelectorAll('select[data-submit]')) select.addEventListener('change', () => select.form.requestSubmit());
  for (const button of document.querySelectorAll('[data-copy]')) {
    if (!navigator.clipboard) continue;
    button.hidden = false;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select it';
      }
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    });
  }
  document.addEventListener('keydown', (event) => {
    const search = document.querySelector('input[name=search]');
    if (event.key === '/' && search && document.activeElement !== search && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      search.focus();
    }
  });
  const body = document.querySelector('[data-tail]');
  const toggle = document.querySelector('[data-tail-toggle]');
  if (!body || !toggle || !window.EventSource) return;
  toggle.hidden = false;
  const state = toggle.querySelector('span');
  let source;
  const start = () => {
    source = new EventSource(body.dataset.tail);
    state.textContent = 'live';
    toggle.classList.add('on');
    source.addEventListener('entry', (event) => {
      const { row } = JSON.parse(event.data);
      if (!row) return;
      body.querySelector('[data-empty]')?.remove();
      body.insertAdjacentHTML('afterbegin', row);
      body.firstElementChild?.classList.add('fresh');
      while (body.children.length > 200) body.lastElementChild.remove();
    });
    source.addEventListener('error', () => (state.textContent = source.readyState === 2 ? 'off' : 'reconnecting'));
    source.addEventListener('open', () => (state.textContent = 'live'));
  };
  const stop = () => {
    source?.close();
    source = undefined;
    state.textContent = 'paused';
    toggle.classList.remove('on');
  };
  toggle.addEventListener('click', () => (source ? stop() : start()));
  start();
})();`;

/** The pages' CSS — light and dark after the system, like the error page (E119). */
export const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--panel:#fff;--text:#1c1f24;--muted:#646b76;--border:#e3e3df;--accent:#2457c5;--accent-soft:#e8eefb;--ok:#15724c;--ok-soft:#e5f4ec;--warn:#9a5b00;--warn-soft:#fbf1dd;--bad:#b4361b;--bad-soft:#fbeee9;--info:#5b4bb7;--info-soft:#efecfb;--code:#f1f1ee;--fresh:#fff6cc;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121314;--panel:#1a1c1e;--text:#e7e8e9;--muted:#9a9fa6;--border:#2c2f33;--accent:#7aa2ff;--accent-soft:#1b2440;--ok:#6fd3a8;--ok-soft:#14261f;--warn:#f0b75a;--warn-soft:#2c2312;--bad:#f07a5a;--bad-soft:#2b1b16;--info:#b3a6ff;--info-soft:#221d3a;--code:#151618;--fresh:#3a3412}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
code,pre{font-family:var(--mono);font-size:12.5px}
header.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel)}
header.top .brand{font-weight:700;text-decoration:none;color:var(--text)}
header.top .dev{font-size:12px;color:var(--muted)}
header.top .usage{margin-left:auto;font-size:12px;color:var(--muted)}
nav.types{display:flex;flex-wrap:wrap;gap:2px 4px;padding:6px 12px;border-bottom:1px solid var(--border);background:var(--panel);position:sticky;top:0;z-index:2}
nav.types a{padding:4px 8px;border-radius:6px;text-decoration:none;color:var(--text);font-size:13px}
nav.types a:hover{background:var(--code)}
nav.types a.current{background:var(--accent-soft);color:var(--accent);font-weight:600}
nav.types .sep{width:1px;background:var(--border);margin:4px 6px}
main{max-width:1280px;margin:0 auto;padding:20px 16px 64px}
h1{font-size:20px;margin:0 0 4px;overflow-wrap:anywhere}
h2{font-size:15px;margin:0 0 10px}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px}
.sub{color:var(--muted);margin:0 0 16px;overflow-wrap:anywhere}
section{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin:0 0 16px;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:16px}
.grid>section{margin:0}
.callout{border-radius:8px;padding:10px 14px;margin:0 0 16px;border:1px solid}
.callout.warn{background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.callout.info{background:var(--info-soft);border-color:color-mix(in srgb,var(--info) 40%,transparent)}
.callout p{margin:0 0 6px}.callout p:last-child{margin:0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:5px 8px;border-top:1px solid var(--border);overflow-wrap:anywhere}
thead th{border-top:0;color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
table.kv th{width:20%;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.time{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
tr.fresh{animation:fresh 2s ease-out}
@keyframes fresh{from{background:var(--fresh)}to{background:transparent}}
tbody tr:hover{background:color-mix(in srgb,var(--code) 60%,transparent)}
td a.row{color:inherit;text-decoration:none}td a.row:hover{text-decoration:underline}
.mono{font-family:var(--mono);font-size:12.5px}
.sql{font-family:var(--mono);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
pre.block{background:var(--code);border-radius:6px;padding:10px 12px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:480px;overflow:auto}
.badge{display:inline-block;font-size:11px;line-height:18px;border:1px solid var(--border);border-radius:4px;padding:0 6px;color:var(--muted);white-space:nowrap;margin:0 2px 2px 0}
.badge.ok{color:var(--ok);background:var(--ok-soft);border-color:transparent}
.badge.warn{color:var(--warn);background:var(--warn-soft);border-color:transparent}
.badge.bad{color:var(--bad);background:var(--bad-soft);border-color:transparent}
.badge.info{color:var(--info);background:var(--info-soft);border-color:transparent}
.badge.accent{color:var(--accent);background:var(--accent-soft);border-color:transparent}
.muted{color:var(--muted)}
p.empty{color:var(--muted);margin:0}
form.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}
form.filters input,form.filters select,form.filters button,.button{font:inherit;font-size:13px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}
form.filters input[name=search]{min-width:min(100%,260px)}
form.filters button,.button{cursor:pointer;text-decoration:none}
.tail{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.tail::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
.tail.on::before{background:var(--ok)}
.command{display:flex;align-items:center;gap:8px;margin:4px 0}
.command code{background:var(--code);border-radius:6px;padding:4px 8px;user-select:all;overflow-wrap:anywhere}
.command button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer}
.props td.bar{width:40%}
.props meter{width:100%;height:10px}
iframe.mail{width:100%;height:70vh;border:1px solid var(--border);border-radius:6px;background:#fff}
.pager{margin:12px 0 0}
.stat{display:inline-block;margin:0 18px 6px 0}.stat b{font-size:18px;display:block}
@media (max-width:640px){table.kv th{width:auto}.hide-sm{display:none}}
`;

/** `'sha256-…'` of a script or style — the pages' CSP allows exactly their own inline code (no nonce to carry around). */
export function cspHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
}

/**
 * The pages' Content-Security-Policy: nothing but their own inline style and script (by hash), requests to this origin (the
 * stream, the mail frame), images from here, and only this origin may frame them (`frame-ancestors 'self'`, the in-page bar of
 * step 9). Forms go nowhere else; no `<base>`.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `style-src ${cspHash(STYLE)}`,
  `script-src ${cspHash(SCRIPT)}`,
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * The CSP of a recorded mail's HTML (`/mails/:id/html`): `sandbox` without `allow-scripts` — opened in its own tab too, no
 * script of the mail runs and the document has an opaque origin (no cookies, no access to the devtools) — inline styles and
 * images as a mail client would show them, nothing fetched by script, framed only by the devtools.
 */
export const MAIL_CSP = [
  'sandbox',
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: http: https:',
  'font-src data: http: https:',
  "frame-ancestors 'self'",
].join('; ');

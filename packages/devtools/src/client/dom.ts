/**
 * Plain DOM for the in-page bar (E117: no UI framework — it shows any adapter's app). Everything shown is set as text
 * (`textContent`), never as markup: what the bar shows is the server's data.
 */

/** What an element may hold: nodes, text — and nothing (`false`, `null`, `undefined` are left out). */
export type Child = Node | string | number | false | null | undefined | readonly Child[];
type Attributes = Record<string, string | number | boolean | undefined | ((event: Event) => void)>;

/** An element with attributes (`on…`: listeners, `true`: present) and children (strings as text). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  append(element, children);
  return element;
}

function append(element: HTMLElement, children: readonly Child[]): void {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(element, child);
    else element.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : (child as Node));
  }
}

/** Bytes of a value's JSON. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/** `1.2 KB`, `830 B`. */
export function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** A value as indented JSON, cut at `max` characters. */
export function json(value: unknown, max = 20_000): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** The bar's look — in its shadow root only, nothing leaks into the app's styles (nor theirs into it). */
export const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.bc { --bg: #15171b; --panel: #1c1f24; --line: #2c3038; --text: #e6e8eb; --muted: #9aa2ad; --accent: #7dd3fc; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
  font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; color: var(--text); }
.pill { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; display: flex; gap: 6px; align-items: center; padding: 5px 10px; border: 0;
  border-radius: 999px; background: var(--panel); color: var(--text); font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 2px 10px rgba(0,0,0,.3); opacity: .85; }
.pill:hover, .pill:focus-visible { opacity: 1; outline: 2px solid var(--accent); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.panel { position: fixed; inset: auto 0 0 0; height: 42vh; min-height: 220px; z-index: 2147483647; display: flex; flex-direction: column;
  background: var(--bg); border-top: 1px solid var(--line); box-shadow: 0 -4px 20px rgba(0,0,0,.35); }
.head { display: flex; align-items: center; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); background: var(--panel); }
.head strong { margin-right: 8px; }
.tab { padding: 7px 10px; border: 0; background: none; color: var(--muted); font: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.spacer { flex: 1; }
.head a, .link { color: var(--accent); background: none; border: 0; font: inherit; cursor: pointer; padding: 0; text-decoration: underline; }
.close { border: 0; background: none; color: var(--muted); font-size: 16px; cursor: pointer; padding: 4px 8px; }
.body { flex: 1; overflow: auto; padding: 8px 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.mono, code, pre { font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin: 4px 0; padding: 6px 8px; background: var(--panel); border-radius: 4px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.badge { display: inline-block; margin: 0 4px 2px 0; padding: 0 6px; border-radius: 999px; background: var(--line); color: var(--text); font-size: 11px; }
.kind { min-width: 64px; text-align: center; }
.k-visit, .k-document { background: #1e3a5f; } .k-reload, .k-partial, .k-deferred { background: #3b2f5c; } .k-background, .k-live { background: #14532d; }
.k-prefetch { background: #374151; } .k-layer { background: #5b3a1e; } .k-island { background: #134e4a; } .k-action, .k-upload { background: #4c1d95; }
.k-validation { background: #713f12; } .k-restore { background: #334155; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
h3 { margin: 10px 0 4px; font-size: 12px; } h3:first-child { margin-top: 0; }
details > summary { cursor: pointer; }
.empty { color: var(--muted); padding: 12px 0; }
`;

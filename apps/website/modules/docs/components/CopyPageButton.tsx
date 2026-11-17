import { useEffect, useRef, useState } from 'react';
import { useHydrated } from '../../site/components/useHydrated.ts';

/** The page's Markdown as text, or an error: only an answer that is Markdown is copied, never an error page. */
async function markdownText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { headers: { accept: 'text/markdown' }, signal });
  if (!response.ok || !/^text\/markdown\b/i.test(response.headers.get('content-type') ?? '')) throw new Error(`${url} is no Markdown`);
  const text = await response.text();
  signal.throwIfAborted();
  return text;
}

/**
 * Copies the page as Markdown: fetches `markdown` (same origin) and writes it to the clipboard. Progressive enhancement: the server
 * renders nothing, so a page without JavaScript carries no dead button. The write starts inside the click with the pending text
 * (`ClipboardItem`), so Safari keeps the click's permission while the fetch runs; where `ClipboardItem` is missing the text is written
 * after the fetch. A new click or an unmount cancels the fetch before it. A failed fetch, an answer that is no Markdown or a refused
 * write leaves the label as it is; success is announced in a polite live region that exists only in the browser.
 */
export function CopyPageButton({ markdown }: { markdown: string }) {
  const hydrated = useHydrated();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A new page (or an unmount) cancels what the old one started and starts the label afresh.
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = undefined;
      clearTimeout(timer.current);
      setCopied(false);
      setBusy(false);
    },
    [markdown],
  );
  if (!hydrated || typeof navigator.clipboard?.writeText !== 'function') return null;

  const copy = () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    const text = markdownText(markdown, request.signal);
    const viaWriteText = () => text.then((value) => navigator.clipboard.writeText(value));
    let written: Promise<void>;
    try {
      if (typeof ClipboardItem === 'function' && typeof navigator.clipboard.write === 'function') {
        // Kept apart: when the constructor throws and the fallback takes over, a failed fetch must not leave this promise unhandled.
        const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
        blob.catch(() => {});
        written = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      } else {
        written = viaWriteText();
      }
    } catch {
      written = viaWriteText(); // a browser that does not take pending text in a ClipboardItem
    }
    written
      .then(() => {
        if (request.signal.aborted) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {}) // refused or failed: the label stays
      .finally(() => {
        if (pending.current !== request) return;
        pending.current = undefined;
        setBusy(false);
      });
  };

  return (
    <>
      <button type="button" className="doc-action" aria-busy={busy || undefined} onClick={copy}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </svg>
        {copied ? 'Copied' : 'Copy page'}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Page copied' : ''}
      </span>
    </>
  );
}

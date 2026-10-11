import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Copies `text`, or the text of `source`, to the clipboard. Progressive enhancement: it renders nothing on the server and nothing
 * where there is no clipboard, so a page without JavaScript carries no dead button. Success is announced in a polite live region.
 */
export function CopyButton({ text, source, label }: { text?: string; source?: RefObject<HTMLElement | null>; label: string }) {
  const [available, setAvailable] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setAvailable(typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function');
    return () => clearTimeout(timer.current);
  }, []);
  if (!available) return null;

  const copy = async () => {
    const value = text ?? source?.current?.innerText;
    if (value === undefined) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // refused (no permission, insecure context): the text stays selectable
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button type="button" className="copy-button" data-copied={copied || undefined} aria-label={label} onClick={() => void copy()}>
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={copied ? 1.8 : 1.4}>
          {copied ? (
            <path d="M3 8.5l3 3 7-7" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
              <path d="M10.5 3.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h.5" />
            </>
          )}
        </svg>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}

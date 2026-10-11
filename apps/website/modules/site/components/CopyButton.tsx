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
      <button type="button" className="copy-button" aria-label={label} onClick={() => void copy()}>
        Copy
      </button>
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
      {copied && (
        <span className="copy-done" aria-hidden="true">
          Copied
        </span>
      )}
    </>
  );
}

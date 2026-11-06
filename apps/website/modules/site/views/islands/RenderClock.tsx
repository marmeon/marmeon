import type { IslandProps } from '@marmeon/http';
import { useIsland, useRoute } from '@marmeon/react';
import { useEffect, useState } from 'react';
import type { ShowRenderClockController } from '../../controllers/ShowRenderClockController.ts';

interface Request {
  readonly bytes: number;
  readonly duration: number;
  readonly cached: boolean;
}

/**
 * The island of the landing page: how long ago the server rendered its answer, what the request cost and how often this tab has
 * loaded it. All three are measured in the browser — the server keeps nothing per visitor.
 */
export default function RenderClock({ renderedAt }: IslandProps<ShowRenderClockController>) {
  const island = useIsland<ShowRenderClockController>();
  const path = useRoute()('site.render-clock');
  const [seen, setSeen] = useState({ props: island.props, loads: 1 });
  // A new props object is a new answer: count it and swap the flash class, which restarts the animation without a timer.
  if (seen.props !== island.props) setSeen({ props: island.props, loads: seen.loads + 1 });
  const now = useNow();
  const request = useRequest(path);
  const age = now === null ? null : Math.max(0, Math.round((now - Date.parse(renderedAt)) / 1000));
  return (
    <div className={`island-clock island-clock--flash-${seen.loads % 2 === 1 ? 'a' : 'b'}`}>
      <p className="island-age">
        Rendered on the server <strong>{age === null ? 'a moment' : `${age} s`}</strong> ago
        <span className="island-at"> (<time dateTime={renderedAt}>{renderedAt}</time>)</span>
      </p>
      <p className="island-loads">Loaded {seen.loads} {seen.loads === 1 ? 'time' : 'times'} on this page</p>
      {request ? (
        <p className="island-request">
          GET {path} · {(request.bytes / 1024).toFixed(1)} KB · {Math.round(request.duration)} ms{request.cached ? ' · from the browser cache' : ''}
        </p>
      ) : null}
      {/* aria-disabled, not disabled: a poll raises `pending` too, and a disabled button would drop a keyboard user's focus. */}
      <button type="button" className="button button--secondary" aria-disabled={island.pending} onClick={() => (island.pending ? undefined : void island.reload())}>
        {island.pending ? 'Loading…' : 'Reload now'}
      </button>
    </div>
  );
}

/** The browser's clock, once a second; null until hydrated (the server's HTML has no age to show). */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The latest Resource Timing entry of the island's URL; nothing where the browser has none (no value is made up). */
function useRequest(path: string): Request | null {
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries().filter((entry): entry is PerformanceResourceTiming => entry.entryType === 'resource' && new URL(entry.name, location.href).pathname === path);
      const last = entries.at(-1);
      if (last) setRequest({ bytes: last.encodedBodySize, duration: last.duration, cached: last.transferSize === 0 && last.encodedBodySize > 0 });
    });
    observer.observe({ type: 'resource', buffered: true });
    return () => observer.disconnect();
  }, [path]);
  return request;
}

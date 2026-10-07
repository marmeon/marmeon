import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import { Suspense, use } from 'react';
import type { ShowStreamingLabController } from '../controllers/ShowLabPageController.ts';

type Props = PageProps<ShowStreamingLabController>;
type Slow = Props['slow'];

/**
 * A slow part of a page, as a Suspense boundary: on the server it takes `slow.delay` ms (the shell is streamed first,
 * this part follows in the same response); in the browser its content is there at once, so hydration renders the same.
 * One promise per page object — the server's is new for every request, the browser's lives as long as the page.
 */
const pending = new WeakMap<Slow, Promise<string>>();
function slowText(slow: Slow): Promise<string> {
  let promise = pending.get(slow);
  if (!promise) {
    const delay = typeof window === 'undefined' ? slow.delay : 0;
    promise = new Promise((resolve) => setTimeout(() => resolve(slow.text), delay));
    pending.set(slow, promise);
  }
  return promise;
}

function SlowPart({ slow }: { slow: Slow }) {
  return <p data-slow-part>{use(slowText(slow))}</p>;
}

export default function Streaming({ slow, now }: Props) {
  return (
    <main>
      <Head title="Streaming" />
      <h1>Streaming</h1>
      <p>
        This paragraph is in the shell: the server sends it right away. Requested at <time dateTime={now}>{now.slice(11, 19)}</time> UTC.
      </p>
      <Suspense fallback={<p aria-busy="true">Loading the slow part…</p>}>
        <SlowPart slow={slow} />
      </Suspense>
    </main>
  );
}

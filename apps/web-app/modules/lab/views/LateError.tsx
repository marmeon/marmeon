import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import { Suspense, use } from 'react';
import type { ShowLateErrorLabController } from '../controllers/ShowLabPageController.ts';

/** Settles after `delayMs` ms on the server — and then fails there; in the browser it works. One promise per page object. */
type Late = PageProps<ShowLateErrorLabController>['late'];
const pending = new WeakMap<Late, Promise<string>>();
function part(late: Late): Promise<string> {
  let promise = pending.get(late);
  if (!promise) {
    const server = typeof window === 'undefined';
    promise = new Promise((resolve, reject) =>
      setTimeout(() => (server ? reject(new Error('The lab’s late part fails on the server, after the shell was sent.')) : resolve('Rendered by the browser.')), server ? late.delayMs : 0),
    );
    pending.set(late, promise);
  }
  return promise;
}

function LatePart({ late }: { late: Late }) {
  return <p data-late-part>{use(part(late))}</p>;
}

export default function LateError({ late }: PageProps<ShowLateErrorLabController>) {
  return (
    <main>
      <Head title="Late error" />
      <h1>Late error</h1>
      <p>The shell renders on the server; the part below fails there after it was sent, and the browser renders it instead.</p>
      <Suspense fallback={<p aria-busy="true">Loading the late part…</p>}>
        <LatePart late={late} />
      </Suspense>
    </main>
  );
}

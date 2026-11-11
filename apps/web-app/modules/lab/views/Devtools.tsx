import { hooks } from '@marmeon/http/client';
import type { PageProps } from '@marmeon/http';
import { Head, Link, useFeature, useRouter } from '@marmeon/react';
import { useEffect, useState } from 'react';
import type { ShowDevtoolsLabController } from '../controllers/ShowDevtoolsLabController.ts';

/**
 * The devtools' bar at work. With `?mismatch=1` the server renders another text than the browser — a hydration
 * mismatch on purpose, listed in the bar's SSR tab. Below, the client hook API — a feature, so it is used where the page
 * runs in the browser (after it mounted): `before` cancels every visit to `blocked`, `invalid` lists the fields a form got back.
 * The three buttons report an error from the page — a `console.error`, an uncaught error, an unhandled rejection — to the dev
 * server, which lists them in the devtools under Browser.
 */
export default function Devtools({ blocked, mismatch }: PageProps<ShowDevtoolsLabController>) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <main>
      <Head title="Devtools lab" />
      <h1>Devtools lab</h1>
      {mismatch ? <p data-rendered-by>Rendered by {typeof window === 'undefined' ? 'the server' : 'the browser'}.</p> : <p><a href="/lab/devtools?mismatch=1">A hydration mismatch on purpose</a></p>}
      <BrowserErrors />
      {mounted ? <Hooks blocked={blocked} /> : null}
    </main>
  );
}

function BrowserErrors() {
  return (
    <section>
      <h2>Browser errors</h2>
      <p>
        <button type="button" onClick={() => console.error('Lab: console.error', { from: 'the devtools lab' })}>
          console.error
        </button>{' '}
        <button type="button" onClick={() => void setTimeout(() => { throw new Error('Lab: an uncaught error'); })}>
          Throw
        </button>{' '}
        <button type="button" onClick={() => void Promise.reject(new Error('Lab: an unhandled rejection'))}>
          Reject
        </button>
      </p>
      <p>
        In development, the entries appear on the <a href="/_marmeon/devtools/browser">devtools’ Browser page</a> (not in the bar).
      </p>
    </section>
  );
}

function Hooks({ blocked }: { blocked: string }) {
  const api = useFeature(hooks);
  const router = useRouter();
  const [cancelled, setCancelled] = useState(0);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [name, setName] = useState('');
  useEffect(() => {
    const stops = [
      api.on('before', (event) => {
        if (new URL(event.url).pathname !== blocked) return;
        event.cancel();
        setCancelled((count) => count + 1);
      }),
      api.on('invalid', (event) => setInvalid((fields) => [...fields, ...Object.keys(event.errors)])),
    ];
    return () => stops.forEach((stop) => stop());
  }, [api, blocked]);
  return (
    <section>
      <h2>Client hooks</h2>
      <p>
        <Link href={blocked} data-blocked-link>
          A link nobody may follow
        </Link>{' '}
        — cancelled <span data-cancelled>{cancelled}</span> times.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void router.visit('/lab/devtools', { method: 'post', data: { name } });
        }}
      >
        <label>
          Name <input name="name" value={name} onChange={(event) => setName(event.target.value)} />
        </label>{' '}
        <button type="submit">Send</button>
      </form>
      <p>
        Invalid fields reported: <span data-invalid>{invalid.join(', ') || 'none'}</span>
      </p>
    </section>
  );
}

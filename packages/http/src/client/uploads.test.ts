// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { LOCATION_HEADER, RELOAD_HEADER, UPLOAD_HEADER, type Upload } from '../page.ts';
import { uploads } from './features/uploads.ts';
import { dirtyPaths } from './forms.ts';
import { loadSensitiveFields, rememberable } from './remember.ts';
import { boot, FakeWindow, ORIGIN, page, settle } from './test-window.ts';

// The rules that tell sensitive fields load on first use; these tests write and read at once.
await loadSensitiveFields();

/** What the fake XHR saw: method, URL, headers and body — and what it answers. */
interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  aborted: boolean;
}

function fakeXhr(sent: Sent[], answer: { status: number; body: string } | 'never' = { status: 200, body: '{"size":3}' }) {
  return class FakeXhr extends EventTarget {
    readonly upload = new EventTarget();
    status = 0;
    statusText = '';
    responseText = '';
    responseURL = '';
    readonly #sent: Sent = { method: '', url: '', headers: {}, body: undefined, aborted: false };
    open(method: string, url: string) {
      Object.assign(this.#sent, { method, url });
    }
    setRequestHeader(name: string, value: string) {
      this.#sent.headers[name] = value;
    }
    getAllResponseHeaders() {
      return 'content-type: application/json\r\n';
    }
    abort() {
      this.#sent.aborted = true;
      this.dispatchEvent(new Event('abort'));
    }
    send(body: unknown) {
      this.#sent.body = body;
      sent.push(this.#sent);
      this.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded: 1, total: 4 }));
      if (answer === 'never') return;
      Object.assign(this, { status: answer.status, responseText: answer.body });
      this.dispatchEvent(new Event('load'));
    }
  } as never;
}

const TOKEN = 'tu_00000000-0000-4000-8000-000000000000.' + 'a'.repeat(43);
const file = (name = 'me.png', type = 'image/png') => new File(['png!'], name, { type });

async function start(options: { target?: (init: RequestInit) => Response | Promise<Response>; answer?: { status: number; body: string } | 'never'; s3?: boolean } = {}) {
  const win = new FakeWindow(`${ORIGIN}/users/1/edit`);
  const sent: Sent[] = [];
  win.XMLHttpRequest = fakeXhr(sent, options.answer);
  const targets: RequestInit[] = [];
  win.handler = (_url, init) => {
    targets.push(init);
    if (options.target) return options.target(init);
    const upload = options.s3
      ? { method: 'POST', url: 'https://bucket.s3.example/', fields: { key: 'tmp/1', policy: 'p', 'x-amz-signature': 's' } }
      : { method: 'PUT', url: '/_marmeon/uploads/1?expires=1&signature=x' };
    return Response.json({ token: TOKEN, upload });
  };
  document.cookie = 'XSRF-TOKEN=xsrf-of-the-session';
  const { navigator } = boot(win, page('/users/1/edit'));
  const feature = navigator.use(uploads);
  const states: (Upload | null)[] = [];
  const first = feature.start({ method: 'put', url: '/users/1/avatar', field: 'avatar', file: file(), onChange: (upload) => states.push(upload) });
  for (let i = 0; i < 6; i++) await settle();
  return { win, sent, targets, feature, first, states, last: () => states.at(-1) ?? first, navigator };
}

describe('uploads: a target from the form’s route, the bytes with progress, the token in the field', () => {
  it('asks the form’s route for a target (its method and URL, the field named), sends the bytes there, and the field then sends the token', async () => {
    const { targets, sent, first, states, last, feature } = await start();
    // At once: uploading, a preview, no token yet.
    expect([first.status, first.uploading, first.name, first.size, first.type]).toEqual(['uploading', true, 'me.png', 4, 'image/png']);
    expect(first.preview).toMatch(/^blob:/);
    // 1. The target: the route's own request, the field in a header, the file described as JSON — with the session's XSRF token.
    expect(targets[0]).toMatchObject({ method: 'PUT', body: JSON.stringify({ name: 'me.png', size: 4, type: 'image/png' }) });
    expect(targets[0]!.headers).toMatchObject({ [UPLOAD_HEADER]: 'avatar', accept: 'application/json', 'x-xsrf-token': 'xsrf-of-the-session' });
    // 2. The bytes: the file itself, to the signed URL, with progress.
    expect(sent[0]).toMatchObject({ method: 'PUT', url: '/_marmeon/uploads/1?expires=1&signature=x', headers: { 'content-type': 'application/octet-stream', [UPLOAD_HEADER]: 'bytes' } });
    expect(sent[0]!.body).toBeInstanceOf(File);
    expect(states.map((state) => state && [state.status, state.progress])).toEqual([
      ['uploading', 0.25],
      ['uploaded', 1],
    ]);
    // 3. The token is what the field sends now — never a property of the upload.
    expect(JSON.stringify({ avatar: last() })).toBe(`{"avatar":"${TOKEN}"}`);
    expect(Object.values(last()!).some((value) => value === TOKEN)).toBe(false);
    expect(feature.size).toBe(1);
  });

  it('straight to S3: the presigned POST’s fields, then the file — no XSRF token and no app header to another origin', async () => {
    const { sent, last } = await start({ s3: true });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://bucket.s3.example/' });
    expect(sent[0]!.headers).toEqual({});
    const body = sent[0]!.body as FormData;
    expect([...body.keys()]).toEqual(['key', 'policy', 'x-amz-signature', 'file']);
    expect(last()!.status).toBe('uploaded');
  });

  it('a target the route refuses: failed, with the field’s message (too large, not allowed) — nothing sent', async () => {
    const { sent, last } = await start({ target: () => Response.json({ message: 'The given data was invalid.', errors: { avatar: ['The file may be at most 2 MB.'] } }, { status: 422 }) });
    expect(sent).toEqual([]);
    expect([last()!.status, last()!.error, JSON.stringify(last())]).toEqual(['failed', 'The file may be at most 2 MB.', '""']);
  });

  it('bytes the server cuts off (413): failed — and the token of its target is never sent', async () => {
    const { last } = await start({ answer: { status: 413, body: '{"message":"The file may be at most 2 MB."}' } });
    expect([last()!.status, last()!.error, JSON.stringify(last())]).toEqual(['failed', 'The file may be at most 2 MB.', '""']);
  });

  it('cancel(): the request is aborted, the preview revoked, the field empty — its token gone', async () => {
    const { sent, first, states, feature } = await start({ answer: 'never' });
    expect(sent[0]!.aborted).toBe(false);
    expect(JSON.stringify(first)).toBe('""'); // on its way: no token yet
    first.cancel();
    expect(sent[0]!.aborted).toBe(true);
    expect(states.at(-1)).toBeNull();
    expect(feature.size).toBe(0);
    expect(JSON.stringify(first)).toBe('""');
  });

  it('a 409 at the target (signed out meanwhile): the document goes — the upload with it', async () => {
    const { win, sent, feature } = await start({ target: () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'history' } }) });
    expect(win.loads).toEqual(['assign /login']);
    expect(sent).toEqual([]);
    expect(feature.size).toBe(0);
  });

  it('a form’s remembered input never keeps an upload — and the field counts as changed while one is there', async () => {
    const { last } = await start();
    expect(rememberable({ name: 'Ada', avatar: last() })).toEqual({ name: 'Ada' });
    expect(dirtyPaths({ avatar: null }, { avatar: last() })).toEqual(['avatar']);
    expect(dirtyPaths({ avatar: null }, { avatar: null })).toEqual([]);
  });
});

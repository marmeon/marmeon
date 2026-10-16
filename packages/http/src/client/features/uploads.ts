/**
 * Uploads as a feature: a file is sent ahead of its form — the form's route hands out a
 * target for the field (its middleware and `authorize` decide), the bytes go there with progress, and the field holds an
 * {@link Upload} whose JSON is the token. Loaded on first use (`<FileInput>` when it renders), in a chunk of its own
 * with the XHR code (`upload.ts`).
 *
 * The uploads under way and their tokens live in a slot of the document — nowhere else: the {@link Upload} a form holds
 * reads its token from there when it is sent. When the document is left (a 409: signed out, a new build) the slot is
 * emptied — every request aborted, every preview revoked, every token gone; an `Upload` still on screen then sends `''`.
 */
import type { Upload } from '../../page.ts';
import { LOCATION_HEADER } from '../../protocol.ts';
import { UPLOAD_HEADER } from '../../upload-header.ts';
import { defineFeature, slot } from '../feature.ts';
import { atOrigin, xsrfToken } from '../request.ts';
import { sendWithProgress } from '../upload.ts';

/** One upload under way — or done, its token kept until the document is left or the upload is cancelled. */
interface Running {
  readonly file: File;
  readonly controller: AbortController;
  readonly preview: string | undefined;
  status: Upload['status'];
  progress: number;
  error: string | undefined;
  /** The token — only once the bytes arrived (before, the target's token is in `pending`). */
  token: string | undefined;
  pending: string | undefined;
}

/** Starts an upload for a field of a route form. */
export interface UploadRequest {
  /** The form's route: its method and URL — the target is asked for there. */
  readonly method: string;
  readonly url: string;
  /** The field (`avatar`). */
  readonly field: string;
  readonly file: File;
  /** Each new state of the upload — `null` once it is cancelled. */
  onChange(upload: Upload | null): void;
}

/** What adapters use of uploads. */
export interface UploadsFeature {
  /** Uploads `file` for the field — the first state at once (`uploading`), then each change through `onChange`. */
  start(request: UploadRequest): Upload;
  /** How many uploads this document holds (under way or done). */
  readonly size: number;
}

const forget = (running: Running) => {
  running.controller.abort();
  running.token = running.pending = undefined;
  if (running.preview) URL.revokeObjectURL(running.preview);
};

/** The uploads of the document: aborted, their previews revoked and their tokens dropped when it is left. */
const UPLOADS = slot(
  'uploads',
  () => new Map<number, Running>(),
  (uploads) => {
    for (const running of uploads.values()) forget(running);
    uploads.clear();
  },
);

/** A same-origin URL: only there does the request carry the XSRF token and the upload header. */
const sameOrigin = (url: string, href: string) => new URL(url, href).origin === new URL(href).origin;

/** The message of a failed answer: the field's validation error, the server's message, or the status. */
async function failure(response: Response, field: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; errors?: Record<string, string[]> };
    return body.errors?.[field]?.[0] ?? body.message ?? `${response.status}`;
  } catch {
    return response.statusText || `${response.status}`;
  }
}

export const uploads = defineFeature('uploads', (host): UploadsFeature => {
  let next = 0;
  const all = () => host.document(UPLOADS);

  const start = ({ method, url, field, file, onChange }: UploadRequest): Upload => {
    const id = ++next;
    const running: Running = {
      file,
      controller: new AbortController(),
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      status: 'uploading',
      progress: 0,
      error: undefined,
      token: undefined,
      pending: undefined,
    };
    all().set(id, running);
    const signal = running.controller.signal;
    const live = () => !host.left && !signal.aborted && all().get(id) === running;
    const cancel = () => {
      if (all().get(id) !== running) return;
      all().delete(id);
      forget(running);
      onChange(null);
    };

    // A function, not an object: a form's remembered input never keeps one (functions are left out), and its JSON — what a
    // form sends — is the token, read from the slot at that moment. The token itself is never a property of it.
    const view = (): Upload => {
      const state = (() => {}) as unknown as Record<string, unknown>;
      Object.defineProperty(state, 'name', { value: file.name, enumerable: true });
      Object.assign(state, {
        '~upload': true,
        size: file.size,
        type: file.type,
        status: running.status,
        uploading: running.status === 'uploading',
        progress: running.progress,
        preview: running.preview,
        error: running.error,
        cancel,
        toJSON: () => {
          const held = host.document(UPLOADS).get(id);
          return held === running && running.status === 'uploaded' ? (running.token ?? '') : '';
        },
      });
      return Object.freeze(state) as unknown as Upload;
    };
    const changed = () => live() && onChange(view());
    const fail = (error: string) => {
      if (!live()) return;
      running.status = 'failed';
      running.error = error;
      running.pending = undefined;
      changed();
    };
    // A 409 (signed out, a new build): the document goes — and with it this upload (the slot is emptied).
    const away = (response: Response) => (response.status === 409 && response.headers.has(LOCATION_HEADER) ? host.documentChange.change(response, 'assign').then(() => true) : false);

    void (async () => {
      const href = host.window.location.href;
      const ownHeaders = (): Record<string, string> => {
        const token = xsrfToken();
        return token ? { 'x-xsrf-token': token } : {};
      };
      try {
        // 1. The target, from the form's own route (its middleware and authorize decide).
        // The form's own route: a path of this site, fetched at this origin.
        const own = new URL(url, href);
        if (own.origin !== host.window.location.origin) return fail(`An upload goes to this site, not to ${own.origin}.`);
        const target = await host.window.fetch(atOrigin(own.pathname + own.search, host.window), {
          method: method.toUpperCase(),
          headers: { ...ownHeaders(), [UPLOAD_HEADER]: field, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, size: file.size, type: file.type }),
          signal,
          credentials: 'same-origin',
        });
        if (await away(target)) return;
        if (!live()) return void (await target.body?.cancel());
        if (!target.ok) return fail(await failure(target, field));
        const { token, upload } = (await target.json()) as { token: string; upload: { method: string; url: string; fields?: Record<string, string> } };
        if (!live()) return;
        running.pending = token;

        // 2. The bytes, with progress — to the app (a signed URL) or straight to S3 (a presigned POST: its fields, then the file).
        let body: BodyInit = file;
        const headers: Record<string, string> = {};
        if (upload.fields) {
          const form = new FormData();
          for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
          form.append('file', file);
          body = form;
        } else {
          headers['content-type'] = 'application/octet-stream';
        }
        if (sameOrigin(upload.url, href)) Object.assign(headers, ownHeaders(), { [UPLOAD_HEADER]: 'bytes', accept: 'application/json' });
        const init = { method: upload.method, headers, body, signal };
        const Xhr = host.window.XMLHttpRequest;
        const sent = await (Xhr
          ? sendWithProgress(Xhr, upload.url, init, ({ loaded, total }) => {
              if (!live() || total === undefined) return;
              running.progress = Math.min(1, loaded / total);
              changed();
            })
          : host.window.fetch(upload.url, init));
        if (await away(sent)) return;
        if (!live()) return;
        if (!sent.ok) return fail(await failure(sent, field));
        // 3. Arrived: the token is what the field sends from now on.
        running.token = running.pending;
        running.pending = undefined;
        running.status = 'uploaded';
        running.progress = 1;
        changed();
      } catch (error) {
        if ((error as { name?: unknown }).name === 'AbortError') return;
        fail(error instanceof Error ? error.message : String(error));
      }
    })();
    return view();
  };

  return {
    start,
    get size() {
      return all().size;
    },
  };
});

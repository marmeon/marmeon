import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_HEADER, PROTOCOL_VERSION } from '../protocol.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse } from './test-window.ts';

/** An XHR that records what it sent and answers with a page. */
function fakeXhr(sent: string[]) {
  return class FakeXhr extends EventTarget {
    readonly upload = new EventTarget();
    status = 0;
    statusText = '';
    responseText = '';
    responseURL = '';
    #url = '';
    open(_method: string, url: string) {
      this.#url = url;
    }
    setRequestHeader() {}
    getAllResponseHeaders() {
      return `content-type: application/json\r\n${PAGE_HEADER}: ${PROTOCOL_VERSION}\r\n`;
    }
    abort() {}
    send() {
      sent.push(`xhr ${this.#url}`);
      Object.assign(this, { status: 200, responseText: JSON.stringify(page('/a', { uploaded: true })), responseURL: `${ORIGIN}/a` });
      this.dispatchEvent(new Event('load'));
    }
  } as never;
}

const upload = () => {
  const data = new FormData();
  data.append('avatar', new Blob(['…'], { type: 'image/png' }), 'avatar.png');
  return data;
};

afterEach(() => {
  vi.doUnmock('./upload.ts');
  vi.resetModules();
});

describe('uploads with progress load their code on first use', () => {
  it('the first upload loads the XHR code, then sends — aborted meanwhile, it sends nothing', async () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const sent: string[] = [];
    win.XMLHttpRequest = fakeXhr(sent);
    win.handler = () => pageResponse(page('/fast'));
    const { navigator, visible } = boot(win, page('/a'));
    // A newer visit replaces the upload before its code arrived: the upload never goes out.
    const uploading = navigator.visit('/a', { method: 'post', data: upload() });
    await navigator.visit('/fast');
    expect(await uploading).toBeUndefined();
    expect(sent).toEqual([]);
    expect(visible().url).toBe('/fast');
    // The next one goes over XHR.
    await navigator.visit('/a', { method: 'post', data: upload() });
    expect(sent).toEqual(['xhr https://app.test/a']);
    expect(visible().props).toEqual({ uploaded: true });
  });

  it('a chunk that cannot load sends the upload with fetch — without progress, never not at all', async () => {
    vi.doMock('./upload.ts', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const { boot: freshBoot, FakeWindow: FreshWindow } = await import('./test-window.ts');
    const win = new FreshWindow(`${ORIGIN}/a`);
    const sent: string[] = [];
    win.XMLHttpRequest = fakeXhr(sent);
    win.handler = (url) => (sent.push(`fetch ${new URL(url).pathname}`), pageResponse(page('/a', { uploaded: true })));
    const { navigator, visible } = freshBoot(win, page('/a'));
    await navigator.visit('/a', { method: 'post', data: upload() });
    expect(sent).toEqual(['fetch /a']);
    expect(visible().props).toEqual({ uploaded: true });
  });
});

import { twoFactorCode } from '@marmeon/auth/testing';
import { Connections } from '@marmeon/database';
import { createHttpKernel } from '@marmeon/server';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { FakeTab } from '../auth/fake-tab.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The recovery codes of an editor are "shown once": the answer of a POST, a layer over the security page. The tab below keeps what a browser keeps
// (history entries with their serialized state, the back/forward cache, the HTTP cache), so Back, Forward and a visit elsewhere show whether a code
// is still reachable without a request and without the password.
let app: TestApp;
let tab: FakeTab;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  tab = new FakeTab(createHttpKernel(app.application), { bfcache: true });
}, 30_000);
afterEach(() => app.close());

/** Every place a code could be read in the tab: what it shows, the layers over it, and the serialized state of every history entry. */
const reachable = (codes: string[]) => {
  const everything = JSON.stringify([tab.visible, tab.layers, tab.entries.map((entry) => entry.state)]);
  return codes.filter((code) => everything.includes(code));
};

/** Eve signs in at the back office, starts the authenticator and turns it on: the answer is a layer with the codes. */
async function enable() {
  await tab.open('/office/login');
  await tab.visit('/office/login', { method: 'post', data: { email: 'eve@office.example.com', password: 'password' } });
  expect(tab.visible.component).toBe('office::Overview');
  await tab.visit('/office/security');
  await tab.visit('/office/security/two-factor/setup', { method: 'post' });
  const { secret } = tab.visible.props.setup as { secret: string };
  await tab.visit('/office/security/two-factor/confirm', { method: 'post', data: { code: twoFactorCode(secret), password: 'password' } });
  expect(tab.layers.map((layer) => layer.component)).toEqual(['office::RecoveryCodes']);
  const codes = tab.layers[0]!.props.codes as string[];
  expect(codes).toHaveLength(10);
  return { codes, secret };
}

describe('the recovery codes of an editor, in a tab', () => {
  it('are a layer over the security page that is gone with Back: no code in the page, the layers or any history entry, and Forward does not reopen it', async () => {
    const { codes } = await enable();
    expect(tab.visible.component).toBe('office::Security');
    // Shown now, in the layer only; no history entry holds them.
    expect(JSON.stringify(tab.visible)).not.toContain(codes[0]);
    expect(JSON.stringify(tab.entries.map((entry) => entry.state))).not.toContain(codes[0]);
    const asked = tab.requests.length;

    await tab.back();
    expect(tab.layers).toEqual([]);
    expect(reachable(codes)).toEqual([]);
    await tab.forward();
    // Forward shows no layer: the codes are not in memory any more. What it asks is the security page (closing the layer reloads it, and the layer's
    // address answers a GET with a redirect to it), never the POST again.
    expect(tab.layers).toEqual([]);
    expect(reachable(codes)).toEqual([]);
    expect(tab.requests.slice(asked)).toEqual(['GET /office/security (visit)', 'GET /office/security/two-factor/confirm (visit)', 'GET /office/security (visit)']);
    // The one request that carried them is the POST that answered with them, once.
    expect(tab.requests.filter((request) => request.startsWith('POST /office/security/two-factor/confirm'))).toHaveLength(1);
  });

  it('are not in the tab after a visit elsewhere and Back through every entry', async () => {
    const { codes } = await enable();
    await tab.back();
    await tab.visit('/office/sessions');
    expect(reachable(codes)).toEqual([]);
    while (tab.index > 0) {
      await tab.back();
      expect(reachable(codes), `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
      expect(tab.layers, `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
    }
    while (tab.index < tab.entries.length - 1) {
      await tab.forward();
      expect(reachable(codes), `Forward to ${tab.entries[tab.index]!.url}`).toEqual([]);
      expect(tab.layers, `Forward to ${tab.entries[tab.index]!.url}`).toEqual([]);
    }
  });

  it('are new ones in a layer too, shown once and gone with Back, and the old ones are not shown again', async () => {
    const { codes: first } = await enable();
    await tab.back();
    await tab.visit('/office/security/two-factor/recovery-codes', { method: 'post', data: { password: 'password' } });
    expect(tab.layers.map((layer) => layer.component)).toEqual(['office::RecoveryCodes']);
    expect(tab.layers[0]!.props).toMatchObject({ signedOut: false });
    const second = tab.layers[0]!.props.codes as string[];
    expect(second).toHaveLength(10);
    expect(second).not.toContain(first[0]);
    await tab.back();
    expect(tab.layers).toEqual([]);
    expect(reachable([...first, ...second])).toEqual([]);
    await tab.forward();
    expect(tab.layers).toEqual([]);
    expect(reachable([...first, ...second])).toEqual([]);
  });

  it('are gone after signing out: Back through every entry shows no code and no layer', async () => {
    const { codes } = await enable();
    await tab.visit('/office/logout', { method: 'post' });
    expect(tab.visible.component).toBe('office::Login');
    expect(tab.layers).toEqual([]);
    while (tab.index > 0) {
      await tab.back();
      expect(reachable(codes), `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
      expect(tab.layers, `Back to ${tab.entries[tab.index]!.url}`).toEqual([]);
    }
    // And nothing of the editor's rows moved: the codes were made once for the editor.
    expect(await app.make(Connections).get<any>().selectFrom('office_two_factor_recovery_codes').select('id').execute()).toHaveLength(10);
  });
});

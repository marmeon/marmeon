import { UserFactory } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { SearchProfileLinksController } from './controllers/SearchProfileLinksController.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

// One featured link per user — the rule is a partial unique index.

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const verified = () => app.factory(UserFactory).create({ email_verified_at: new Date() });
const links = () => app.make(ProfileLinkRepository);
const link = (user_id: number, label: string, featured = false) => links().insert({ user_id, label, url: 'https://example.com', featured });
const path = (user: { public_id: string }, id: string) => `/users/${user.public_id}/links/${id}/feature`;

describe('the featured link of a profile', () => {
  it('refuses a second featured link of one user, but not unfeatured ones or the feature of another user', async () => {
    const ada = await verified();
    const bob = await verified();
    const row = (user_id: number, label: string, featured?: boolean) => links().tryInsert({ user_id, label, url: 'https://example.com', ...(featured === undefined ? {} : { featured }) });
    expect((await row(ada.id, 'First', true)).ok).toBe(true);
    expect(await row(ada.id, 'Second', true)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['user_id'] } });
    expect((await row(ada.id, 'Third')).ok).toBe(true);
    expect((await row(ada.id, 'Fourth')).ok).toBe(true);
    expect((await row(bob.id, 'Bob featured', true)).ok).toBe(true);
    expect(await links().count()).toBe(4);
  });

  it('features a link, unfeatures the one featured before and leaves the feature of another user alone', async () => {
    const ada = await verified();
    const bob = await verified();
    const bobs = await link(bob.id, 'Bob featured', true);
    const first = await link(ada.id, 'A');
    const second = await link(ada.id, 'B');
    const asAda = app.actingAs(ada);
    const back = `/users/${ada.public_id}/links`;
    await asAda.put(path(ada, first.id)).assertRedirect(back);
    expect(await links().find(first.id)).toMatchObject({ featured: true });
    await asAda.put(path(ada, second.id)).assertRedirect(back);
    expect(await links().find(first.id)).toMatchObject({ featured: false });
    expect(await links().find(second.id)).toMatchObject({ featured: true });
    expect(await links().find(bobs.id)).toMatchObject({ featured: true });
  });

  it('features only the link it is given, whoever the user of the other feature is', async () => {
    const ada = await verified();
    const bob = await verified();
    const bobs = await link(bob.id, 'Bob featured', true);
    const adas = await link(ada.id, 'Ada featured', true);
    const other = await link(ada.id, 'Other');
    expect((await links().feature(other)).ok).toBe(true);
    expect(await links().find(adas.id)).toMatchObject({ featured: false });
    expect(await links().find(bobs.id)).toMatchObject({ featured: true });
  });

  it('lists the featured link first, although it is the newest', async () => {
    const ada = await verified();
    // Explicit creation times: rows made in one millisecond have no order.
    const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();
    await links().insert({ user_id: ada.id, label: 'Oldest', url: 'https://example.com', created_at: at(1) });
    await links().insert({ user_id: ada.id, label: 'Newer', url: 'https://example.com', created_at: at(2) });
    const newest = await links().insert({ user_id: ada.id, label: 'Newest, featured', url: 'https://example.com', created_at: at(3) });
    await app.actingAs(ada).put(path(ada, newest.id)).assertRedirect();
    await app.actingAs(ada).navigating().get(`/users/${ada.public_id}/links`).assertPage<SearchProfileLinksController>('user-profile/Links', (props) => {
      expect(props.links.map((each) => each.label)).toEqual(['Newest, featured', 'Oldest', 'Newer']);
      expect(props.links[0]).toMatchObject({ featured: true });
    });
  });

  it('hints the profile when a link is featured or unfeatured, and not for a refused request', async () => {
    const ada = await verified();
    const bob = await verified();
    const mine = await link(ada.id, 'A');
    await app.actingAs(ada).put(path(ada, mine.id)).assertRedirect();
    app.broadcast.assertRefreshed(`users.${ada.public_id}`, { only: ['profile'], times: 1 });
    await app.actingAs(ada).delete(path(ada, mine.id)).assertRedirect();
    app.broadcast.assertRefreshed(`users.${ada.public_id}`, { only: ['profile'], times: 2 });
    // Another user's refused request hints nobody.
    await app.actingAs(bob).put(path(ada, mine.id)).assertForbidden();
    app.broadcast.assertRefreshed(`users.${ada.public_id}`, { only: ['profile'], times: 2 });
  });

  it('keeps the version of every link it touches, so a rename opened before still saves', async () => {
    const ada = await verified();
    const first = await link(ada.id, 'First', true);
    const second = await link(ada.id, 'Second');
    const seenFirst = new Date(first.updated_at);
    const seenSecond = new Date(second.updated_at);
    const rename = (id: string, seen: Date) => links().renameIfCurrent(id, 'Renamed', seen, new Date(seenSecond.getTime() + 1000));
    // Featuring the second unfeatures the first; neither version moves.
    expect((await links().feature(second)).ok).toBe(true);
    expect(new Date((await links().find(first.id))!.updated_at)).toEqual(seenFirst);
    expect(new Date((await links().find(second.id))!.updated_at)).toEqual(seenSecond);
    expect((await rename(second.id, seenSecond))?.ok).toBe(true);
    // Unfeaturing keeps it too.
    const renamed = new Date((await links().find(second.id))!.updated_at);
    expect((await links().unfeature(second.id)).ok).toBe(true);
    expect(new Date((await links().find(second.id))!.updated_at)).toEqual(renamed);
    expect((await rename(first.id, seenFirst))?.ok).toBe(true);
  });

  it('never lets a rename that saved be overwritten with the version it started from, however the write and the rename interleave', async () => {
    const ada = await verified();
    for (const [name, change] of [
      ['unfeature', (row: { id: string; user_id: number }) => links().unfeature(row.id)],
      ['feature', (row: { id: string; user_id: number }) => links().feature(row)],
    ] as const) {
      for (let offset = 0; offset <= 40; offset++) {
        const row = await link(ada.id, `${name} ${offset}`, name === 'unfeature');
        const seen = new Date(row.updated_at);
        const changing = change(row);
        for (let tick = 0; tick < offset; tick++) await Promise.resolve();
        const renaming = links().renameIfCurrent(row.id, 'Renamed', seen, new Date(seen.getTime() + 1000));
        const [, renamed] = await Promise.all([changing, renaming]);
        const after = (await links().find(row.id))!;
        if (renamed?.ok) {
          expect(new Date(after.updated_at).getTime(), `${name} at offset ${offset}`).toBeGreaterThan(seen.getTime());
          expect(after.label).toBe('Renamed');
        }
        await links().delete(row.id);
      }
    }
  });

  it('unfeatures a link', async () => {
    const ada = await verified();
    const featured = await link(ada.id, 'A', true);
    await app.actingAs(ada).delete(path(ada, featured.id)).assertRedirect(`/users/${ada.public_id}/links`);
    expect(await links().find(featured.id)).toMatchObject({ featured: false });
  });

  it('answers missing when the link is gone, featuring or unfeaturing', async () => {
    const ada = await verified();
    const gone = await link(ada.id, 'Gone');
    await links().delete(gone.id);
    expect(await links().feature(gone)).toEqual({ ok: false, error: { kind: 'missing' } });
    expect(await links().unfeature(gone.id)).toEqual({ ok: false, error: { kind: 'missing' } });
  });

  it('sends a guest to the sign-in page and leaves the link as it is', async () => {
    const ada = await verified();
    const featured = await link(ada.id, 'A', true);
    await app.put(path(ada, featured.id)).assertRedirect('/login');
    await app.delete(path(ada, featured.id)).assertRedirect('/login');
    expect(await links().find(featured.id)).toMatchObject({ featured: true });
  });

  it("refuses a stranger on somebody else's profile (403) and answers 404 for a link of another user under one's own", async () => {
    const ada = await verified();
    const bob = await verified();
    const adas = await link(ada.id, 'Ada featured', true);
    const bobs = await link(bob.id, 'Bob link');
    const asBob = app.actingAs(bob);
    await asBob.put(path(ada, adas.id)).assertForbidden();
    await asBob.delete(path(ada, adas.id)).assertForbidden();
    await asBob.put(path(bob, adas.id)).assertNotFound();
    await asBob.delete(path(bob, adas.id)).assertNotFound();
    expect(await links().find(adas.id)).toMatchObject({ featured: true });
    expect(await links().find(bobs.id)).toMatchObject({ featured: false });
  });
});

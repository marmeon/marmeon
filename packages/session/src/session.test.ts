import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '@marmeon/core';
import { RedirectResult } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { plainSessionCodec } from './codec.ts';
import type { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { sessionKey, SessionStore, type SessionPayload } from './store.ts';
import { FileSessionStore } from './stores/file.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { wrapped } from './test-helpers/wrapped-store.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

declare module './session.ts' {
  interface SessionData {
    user_id: string;
    visits: number;
  }
}

const config = { lifetimeMinutes: 120 } as SessionConfig;

/** One request: start the session from `id`, run `use`, save. Returns the id for the next request. */
async function request(store: SessionStore, id: string | undefined, use: (session: Session) => void = () => {}): Promise<Session> {
  const session = new Session(store, config, plainSessionCodec);
  await session.start(id);
  use(session);
  await session.save();
  return session;
}

/** The payload stored for the session `id` (under its key), as JSON. */
async function stored(store: SessionStore, id: string): Promise<SessionPayload | undefined> {
  const record = await store.read(sessionKey(id));
  return record ? (JSON.parse(record.data) as SessionPayload) : undefined;
}

describe('Session', () => {
  it('starts a new session for unknown, invalid or missing ids — never trusting the client', async () => {
    const store = new MemorySessionStore();
    const fresh = await request(store, undefined);
    expect(fresh.id).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect((await request(store, 'x'.repeat(40))).id).not.toBe('x'.repeat(40));
    expect((await request(store, '../../etc/passwd')).id).toMatch(/^[A-Za-z0-9_-]{40}$/);
  });

  it('keeps data across requests', async () => {
    const store = new MemorySessionStore();
    const first = await request(store, undefined, (session) => {
      session.put('user_id', '1');
      session.put('visits', 1);
      session.put('cart', ['book']);
    });
    const second = await request(store, first.id, (session) => {
      expect(session.id).toBe(first.id);
      expect(session.get('user_id')).toBe('1');
      expect(session.pull('cart')).toEqual(['book']);
      session.forget('visits');
    });
    await request(store, second.id, (session) => {
      expect(session.all()).toEqual({ user_id: '1' }); // no _token / _flash bookkeeping
      expect(session.has('cart')).toBe(false);
    });
  });

  it('keeps flash data for exactly one following request', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.flashData('status', 'Saved.'));
    await request(store, id, (session) => expect(session.get('status')).toBe('Saved.'));
    await request(store, id, (session) => expect(session.get('status')).toBeUndefined());
  });

  it('keeps flash messages until a response takes them — not aged by the requests in between; a 409 puts them back', async () => {
    const store = new MemorySessionStore();
    const message = (id: string) => ({ id, key: 'toast', data: { message: 'Saved.' } });
    const { id } = await request(store, undefined, (session) => session.queueFlash(message('1')));
    // A prefetch, an island, an API call: none takes them — they wait, however many there are.
    for (let other = 0; other < 3; other++) await request(store, id, (session) => expect(session.hasFlash()).toBe(true));
    await request(store, id, (session) => {
      expect(session.takeFlash()).toEqual([message('1')]);
      // The answer became a 409 (signed in or out, a new build): not shown — back for the page that loads instead.
      session.reflash();
    });
    await request(store, id, (session) => {
      expect(session.takeFlash().map((taken) => taken.id)).toEqual(['1']);
      expect(session.takeFlash()).toEqual([]);
    });
    await request(store, id, (session) => expect(session.hasFlash()).toBe(false));
    // A read-only request (an island) takes none.
    const { id: second } = await request(store, undefined, (session) => session.queueFlash(message('2')));
    const island = new Session(store, config, plainSessionCodec);
    await island.start(second);
    island.lock(() => false);
    expect(island.takeFlash()).toEqual([]);
    expect(island.all()).toEqual({});
  });

  it('binds a flash message to the document whose request flashed it: another document leaves it, a full load takes it', async () => {
    const store = new MemorySessionStore();
    const message = (id: string, document?: string) => ({ id, key: 'toast', data: { message: 'Saved.' }, ...(document ? { document } : {}) });
    const { id } = await request(store, undefined, (session) => {
      session.queueFlash(message('a', 'tab-a'));
      session.queueFlash(message('free'));
    });
    // Tab B's request: only the message bound to no document; tab A's stays — and waits for A.
    await request(store, id, (session) => {
      expect(session.hasFlash('tab-b')).toBe(true);
      expect(session.takeFlash('tab-b').map((taken) => taken.id)).toEqual(['free']);
      expect(session.hasFlash('tab-b')).toBe(false);
      expect(session.hasFlash('tab-a')).toBe(true);
    });
    await request(store, id, (session) => expect(session.takeFlash('tab-a').map((taken) => taken.id)).toEqual(['a']));
    // A request naming no document (a full page load) takes every message.
    await request(store, id, (session) => session.queueFlash(message('b', 'tab-b')));
    await request(store, id, (session) => expect(session.takeFlash().map((taken) => taken.id)).toEqual(['b']));
  });

  it('keeps the conflict of a form that went back apart from the messages: only takeSentBack() takes it, validated, hidden from all()', async () => {
    const store = new MemorySessionStore();
    const entry = (id: string, data: unknown, document?: string) => ({ id, key: '_sent_back', data, ...(document ? { document } : {}) });
    const { id } = await request(store, undefined, (session) => session.queueSentBack(entry('c', { conflict: { message: 'Stale.', current: { v: 2 } } }, 'tab-a')));
    await request(store, id, (session) => {
      // Not a message (a prefetch is told something waits), and not session data.
      expect(session.hasFlash('tab-a')).toBe(true);
      expect(session.takeFlash('tab-a')).toEqual([]);
      expect(session.all()).toEqual({});
      // Another document's request leaves it.
      expect(session.takeSentBack('tab-b')).toBeUndefined();
    });
    await request(store, id, (session) => {
      expect(session.takeSentBack('tab-a')).toEqual({ conflict: { message: 'Stale.', current: { v: 2 } } });
      // A 409 puts it back, like a message.
      session.reflash();
    });
    await request(store, id, (session) => {
      expect(session.takeSentBack()).toEqual({ conflict: { message: 'Stale.', current: { v: 2 } } });
      expect(session.takeSentBack()).toBeUndefined();
    });
    // A value of another shape is dropped, never handed on.
    for (const data of [null, 'Stale.', ['Stale.'], { conflict: { message: 5 } }, { conflict: 'Stale.' }, {}]) {
      const { id: other } = await request(store, undefined, (session) => session.queueSentBack(entry('x', data)));
      await request(store, other, (session) => {
        expect(session.takeSentBack()).toBeUndefined();
        expect(session.takeSentBack()).toBeUndefined();
      });
    }
    // A submit binds it: only the request carrying that id takes it, not a poll or a partial reload of the same document.
    const { id: bound } = await request(store, undefined, (session) => session.queueSentBack({ ...entry('b', { conflict: { message: 'Stale.' } }, 'tab-a'), form: 'submit-1' }));
    await request(store, bound, (session) => {
      expect(session.takeSentBack('tab-a')).toBeUndefined();
      expect(session.takeSentBack('tab-a', 'submit-2')).toBeUndefined();
      // One bound to a submit makes a prefetch wait too: it must not stand in for the follow-up.
      expect(session.hasFlash('tab-a')).toBe(true);
    });
    await request(store, bound, (session) => expect(session.takeSentBack('tab-a', 'submit-1')).toEqual({ conflict: { message: 'Stale.' } }));
    // Released (its follow-up became a full load): the rule of the document applies, and a prefetch waits for it.
    const { id: released } = await request(store, undefined, (session) => session.queueSentBack({ ...entry('r', { conflict: { message: 'Stale.' } }, 'tab-a'), form: 'submit-1' }));
    await request(store, released, (session) => {
      session.releaseSentBack('tab-b', 'submit-1');
      session.releaseSentBack('tab-a', 'submit-2');
      expect(session.takeSentBack('tab-a')).toBeUndefined();
      session.releaseSentBack('tab-a', 'submit-1');
      expect(session.hasFlash('tab-a')).toBe(true);
      expect(session.takeSentBack('tab-a')).toEqual({ conflict: { message: 'Stale.' } });
    });
    // A later submit of the same document ends a conflict it did not answer; another document's submit does not.
    const { id: dropped } = await request(store, undefined, (session) => session.queueSentBack({ ...entry('d', { conflict: { message: 'Stale.' } }, 'tab-a'), form: 'submit-1' }));
    await request(store, dropped, (session) => {
      // Its own submit ends nothing; a later one of the same document does.
      session.dropSentBack('tab-a', 'submit-1');
      session.dropSentBack('tab-a', 'submit-2');
    });
    await request(store, dropped, (session) => expect(session.takeSentBack('tab-a', 'submit-1')).toBeUndefined());
    const { id: kept } = await request(store, undefined, (session) => session.queueSentBack({ ...entry('k', { conflict: { message: 'Stale.' } }, 'tab-a'), form: 'submit-1' }));
    await request(store, kept, (session) => {
      session.dropSentBack('tab-b', 'submit-9');
      session.dropSentBack(undefined, 'submit-9');
      session.dropSentBack('tab-a', 'submit-1');
    });
    await request(store, kept, (session) => expect(session.takeSentBack('tab-a', 'submit-1')).toEqual({ conflict: { message: 'Stale.' } }));
    // A read-only request takes none.
    const { id: third } = await request(store, undefined, (session) => session.queueSentBack(entry('r', { conflict: { message: 'Stale.' } })));
    const island = new Session(store, config, plainSessionCodec);
    await island.start(third);
    island.lock(() => false);
    expect(island.takeSentBack()).toBeUndefined();
  });

  it('keeps the newest conflict of each document and submit — ten at most — beside the twenty messages: a run of stale posts evicts no toast', async () => {
    const store = new MemorySessionStore();
    const toast = (id: number) => ({ id: `t${id}`, key: 'toast', data: { message: `Saved ${id}.` } });
    const stale = (id: string, document?: string, form?: string) => ({ id, key: '_sent_back', data: { conflict: { message: `Stale ${id}.` } }, ...(document ? { document } : {}), ...(form ? { form } : {}) });
    const { id } = await request(store, undefined, (session) => {
      for (let n = 0; n < 20; n++) session.queueFlash(toast(n));
      // The same document and submit: the newest replaces; no document and no id: one slot too.
      for (let n = 0; n < 25; n++) session.queueSentBack(stale(`same${n}`, 'tab-a', 's1'));
      for (let n = 0; n < 25; n++) session.queueSentBack(stale(`anon${n}`));
    });
    await request(store, id, (session) => {
      expect(session.takeFlash().map((message) => message.id)).toEqual(Array.from({ length: 20 }, (_, n) => `t${n}`));
      expect(session.takeSentBack('tab-a', 's1')).toEqual({ conflict: { message: 'Stale same24.' } });
      expect(session.takeSentBack()).toEqual({ conflict: { message: 'Stale anon24.' } });
      expect(session.takeSentBack()).toBeUndefined();
    });
    // Another tab’s conflict does not erase this one’s.
    const { id: tabs } = await request(store, undefined, (session) => {
      session.queueSentBack(stale('a', 'tab-a', 'a1'));
      session.queueSentBack(stale('b', 'tab-b', 'b1'));
    });
    await request(store, tabs, (session) => {
      expect(session.takeSentBack('tab-a', 'a1')).toEqual({ conflict: { message: 'Stale a.' } });
      expect(session.takeSentBack('tab-b', 'b1')).toEqual({ conflict: { message: 'Stale b.' } });
    });
    // Beyond ten the oldest is dropped.
    const { id: many } = await request(store, undefined, (session) => {
      for (let n = 0; n < 15; n++) session.queueSentBack(stale(`m${n}`, `tab-${n}`, `s${n}`));
    });
    await request(store, many, (session) => {
      expect(session.takeSentBack('tab-0', 's0')).toBeUndefined();
      expect(session.takeSentBack('tab-4', 's4')).toBeUndefined();
      expect(session.takeSentBack('tab-5', 's5')).toEqual({ conflict: { message: 'Stale m5.' } });
      expect(session.takeSentBack('tab-14', 's14')).toEqual({ conflict: { message: 'Stale m14.' } });
    });
    // Twenty-one toasts: the oldest goes, as before — and a conflict never counts among them.
    const { id: second } = await request(store, undefined, (session) => {
      session.queueSentBack(stale('c'));
      for (let n = 0; n < 21; n++) session.queueFlash(toast(n));
    });
    await request(store, second, (session) => {
      expect(session.takeFlash()).toHaveLength(20);
      expect(session.takeSentBack()).toEqual({ conflict: { message: 'Stale c.' } });
    });
  });

  it('an island resolved in-process reads the same old() and errors as its page: the record the page took, not a second take', async () => {
    const store = new MemorySessionStore();
    const record = { id: 'r', key: '_sent_back', data: { errors: { title: ['Required.'] }, input: { title: 'typed' } }, document: 'tab-a', form: 's1' };
    const { id } = await request(store, undefined, (session) => session.queueSentBack(record));
    const page = new Session(store, config, plainSessionCodec);
    await page.start(id);
    page.expectSentBack('tab-a', 's1');
    const island = new Session(store, config, plainSessionCodec);
    island.adopt(page);
    island.lock(() => false);
    expect(island.old()).toEqual({ title: 'typed' });
    expect(island.shownErrors()).toEqual({ title: ['Required.'] });
    expect(page.old()).toEqual({ title: 'typed' });
    // A request that is no page (a prefetch, an island of its own) shows none of it while a record waits.
    await request(store, id, (other) => {
      expect(other.old()).toEqual({});
      expect(other.shownErrors()).toEqual({});
    });
  });

  describe('the lifetime of a record of a form sent back', () => {
    afterEach(() => vi.useRealTimers());

    it('ends after five minutes: not taken, not waited for, and dropped when the session loads or another record is queued', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const store = new MemorySessionStore();
      const record = (id: string, document: string) => ({ id, key: '_sent_back', data: { conflict: { message: 'Stale.' } }, document, form: id });
      const { id } = await request(store, undefined, (session) => session.queueSentBack(record('a', 'tab-a')));
      vi.advanceTimersByTime(5 * 60_000);
      await request(store, id, (session) => expect(session.hasFlash('tab-a')).toBe(true));
      vi.advanceTimersByTime(1_000);
      await request(store, id, (session) => {
        expect(session.hasFlash('tab-a')).toBe(false);
        expect(session.takeSentBack('tab-a', 'a')).toBeUndefined();
      });
      expect((await stored(store, id))?._sent_back).toBeUndefined();
      // Queueing a new record drops the expired one beside it.
      const { id: second } = await request(store, undefined, (session) => session.queueSentBack(record('b', 'tab-b')));
      vi.advanceTimersByTime(6 * 60_000);
      await request(store, second, (session) => session.queueSentBack(record('c', 'tab-c')));
      const left = ((await stored(store, second))?._sent_back ?? []) as { id: string }[];
      expect(left.map((message) => message.id)).toEqual(['c']);
    });
  });

  it('keeps the records of forms sent back under a key of their own: a flash message taker of the release before finds none', async () => {
    const store = new MemorySessionStore();
    const record = (id: string, document: string) => ({ id, key: '_sent_back', data: { conflict: { message: 'Stale.' } }, document });
    const { id } = await request(store, undefined, (session) => {
      session.queueSentBack(record('r', 'tab-a'));
      session.queueFlash({ id: 'm', key: 'toast', data: { message: 'Saved.' } });
    });
    const payload = (await stored(store, id)) ?? {};
    expect(((payload._flash_messages ?? []) as { id: string }[]).map((message) => message.id)).toEqual(['m']);
    expect(((payload._sent_back ?? []) as { id: string }[]).map((message) => message.id)).toEqual(['r']);
    await request(store, id, (session) => expect(session.takeFlash().map((message) => message.id)).toEqual(['m']));
  });

  describe('plain copies that a record of a form sent back mirrors', () => {
    const rec = (id: string, errors: Record<string, string[]>, input: Record<string, unknown> = { title: id }) => ({ id, key: '_sent_back', data: { errors, input }, document: 'tab-a', form: id });
    /** A refused form: its plain copies, and the record that mirrors them. */
    const refuse = (session: Session, id: string) => {
      session.flashData('errors', { title: [`Required ${id}.`] });
      session.flashInput({ title: id });
      session.queueSentBack(rec(id, { title: [`Required ${id}.`] }));
    };

    it('keeps the mark of a copy when a concurrent request aged the mark away: the other tab never sees the copy', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      // A poll and a second refused submit load the same session; the poll saves first and ages the first copies and their mark away.
      const poll = new Session(store, config, plainSessionCodec);
      await poll.start(id);
      const submit = new Session(store, config, plainSessionCodec);
      await submit.start(id);
      poll.put('visits', 1);
      await poll.save();
      refuse(submit, 'two');
      await submit.save();
      await request(store, id, (other) => {
        expect(other.shownErrors()).toEqual({});
        expect(other.old()).toEqual({});
      });
    });

    it('does not expose a copy another request just replaced when this one unmarks the older generation: errors', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      const a = new Session(store, config, plainSessionCodec);
      await a.start(id);
      const b = new Session(store, config, plainSessionCodec);
      await b.start(id);
      // B refuses anew (marked) and saves first; A flashes errors equal to the ones it loaded, unmirrored.
      refuse(b, 'two');
      await b.save();
      a.flashData('errors', { title: ['Required one.'] });
      await a.save();
      await request(store, id, (other) => {
        expect(other.shownErrors()).toEqual({ title: ['Required one.'] });
        // B's input is still its record's mirror: shown to no one.
        expect(other.old()).toEqual({});
      });
    });

    it('does not expose a copy another request just replaced when this one unmarks the older generation: input', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      const a = new Session(store, config, plainSessionCodec);
      await a.start(id);
      const b = new Session(store, config, plainSessionCodec);
      await b.start(id);
      refuse(b, 'two');
      await b.save();
      a.flashInput({ title: 'one' });
      await a.save();
      await request(store, id, (other) => {
        expect(other.old()).toEqual({ title: 'one' });
        expect(other.shownErrors()).toEqual({});
      });
    });

    it('keeps the copies of a refused form hidden when the request that aged the older ones saves last', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      const poll = new Session(store, config, plainSessionCodec);
      await poll.start(id);
      const submit = new Session(store, config, plainSessionCodec);
      await submit.start(id);
      refuse(submit, 'two');
      await submit.save();
      poll.put('visits', 1);
      await poll.save();
      await request(store, id, (other) => {
        expect(other.shownErrors()).toEqual({});
        expect(other.old()).toEqual({});
      });
    });

    it.each([
      ['errors', (session: Session) => session.flashData('errors', { title: ['Same.'] }), (session: Session) => session.shownErrors(), { title: ['Same.'] }],
      ['input', (session: Session) => session.flashInput({ title: 'same' }), (session: Session) => session.old(), { title: 'same' }],
    ])('shows a plain-only refusal’s own %s when a concurrent request marked the same value as a record’s copy', async (_name, flash, read, expected) => {
      const store = new MemorySessionStore();
      const same = { id: 'r', key: '_sent_back', data: { errors: { title: ['Same.'] }, input: { title: 'same' } }, document: 'tab-a', form: 'r' };
      // The session holds the plain, unmarked copies, aged to the next request.
      const { id } = await request(store, undefined, (session) => {
        session.flashData('errors', { title: ['Same.'] });
        session.flashInput({ title: 'same' });
      });
      const refusal = new Session(store, config, plainSessionCodec);
      await refusal.start(id);
      const plain = new Session(store, config, plainSessionCodec);
      await plain.start(id);
      // One refuses with a record and the same values (marked), and saves first; the other flashes the same value again, with no record.
      refusal.flashData('errors', { title: ['Same.'] });
      refusal.flashInput({ title: 'same' });
      refusal.queueSentBack(same);
      await refusal.save();
      flash(plain);
      await plain.save();
      await request(store, id, (other) => expect(read(other)).toEqual(expected));
    });

    it('is absent from the stored session once the copies aged away', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      expect(await stored(store, id)).toHaveProperty('_flash_mirrored');
      await request(store, id);
      await request(store, id);
      const payload = (await stored(store, id)) ?? {};
      expect(payload).not.toHaveProperty('_flash_mirrored');
      expect(payload).not.toHaveProperty('errors');
      expect(payload).toHaveProperty('_sent_back');
    });

    it('shows what the request flashed itself after the record: that value is not a copy', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => {
        refuse(session, 'one');
        session.flashData('errors', { title: ['Own.'] });
      });
      await request(store, id, (session) => expect(session.shownErrors()).toEqual({ title: ['Own.'] }));
    });

    it('is kept with its copies by keep(): a later request of another tab still sees neither', async () => {
      const store = new MemorySessionStore();
      const { id } = await request(store, undefined, (session) => refuse(session, 'one'));
      await request(store, id, (session) => session.keep('errors', '_old_input'));
      await request(store, id, (later) => {
        expect(later.shownErrors()).toEqual({});
        expect(later.old()).toEqual({});
      });
    });
  });

  it('hands an island a copy of the record: what the island changes in old() and the errors, the page does not see', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.queueSentBack({ id: 'r', key: '_sent_back', data: { errors: { title: ['Required.'] }, input: { title: 'typed' } }, document: 'tab-a', form: 's1' }));
    const page = new Session(store, config, plainSessionCodec);
    await page.start(id);
    page.expectSentBack('tab-a', 's1');
    const island = new Session(store, config, plainSessionCodec);
    island.adopt(page);
    island.old().title = 'changed';
    island.shownErrors().title!.push('Injected.');
    expect(page.old()).toEqual({ title: 'typed' });
    expect(page.shownErrors()).toEqual({ title: ['Required.'] });
  });

  it('forgets the record this request took when the session is flushed or invalidated: old() and the errors are empty, and reflash() brings nothing back', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.queueSentBack({ id: 'r', key: '_sent_back', data: { errors: { title: ['Required.'] }, input: { title: 'typed' } }, document: 'tab-a', form: 's1' }));
    const session = new Session(store, config, plainSessionCodec);
    await session.start(id);
    session.expectSentBack('tab-a', 's1');
    expect(session.old()).toEqual({ title: 'typed' });
    session.invalidate();
    expect(session.old()).toEqual({});
    expect(session.shownErrors()).toEqual({});
    session.reflash();
    expect(session.takeSentBack('tab-a', 's1')).toBeUndefined();
  });

  it('merges the records of two requests of one session by id: both are kept, and one a faster request took does not come back', async () => {
    const store = new MemorySessionStore();
    const record = (id: string, document: string) => ({ id, key: '_sent_back', data: { conflict: { message: `Stale ${id}.` } }, document, form: id });
    const { id } = await request(store, undefined, (session) => session.queueSentBack(record('x', 'tab-x')));
    const first = new Session(store, config, plainSessionCodec);
    await first.start(id);
    const second = new Session(store, config, plainSessionCodec);
    await second.start(id);
    first.queueSentBack(record('a', 'tab-a'));
    expect(second.takeSentBack('tab-x', 'x')).toEqual({ conflict: { message: 'Stale x.' } });
    second.queueSentBack(record('b', 'tab-b'));
    await first.save();
    await second.save();
    const ids = (((await stored(store, id))?._sent_back ?? []) as { id: string }[]).map((message) => message.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('a conflict released to the document stays released when another request of the session saves in between', async () => {
    const store = new MemorySessionStore();
    const bound = { id: 'c', key: '_sent_back', data: { conflict: { message: 'Stale.' } }, document: 'tab-a', form: 'submit-1' };
    const { id } = await request(store, undefined, (session) => session.queueSentBack(bound));
    // The release (the asset-version 409 of the follow-up) and an unrelated write of another request start from the same session.
    const release = new Session(store, config, plainSessionCodec);
    await release.start(id);
    const other = new Session(store, config, plainSessionCodec);
    await other.start(id);
    other.put('visits', 1);
    await other.save();
    release.releaseSentBack('tab-a', 'submit-1');
    await release.save();
    await request(store, id, (session) => {
      expect(session.get('visits')).toBe(1);
      // No submit id, as on a full document load: it is taken — the merge kept the release, not the old binding.
      expect(session.takeSentBack('tab-a')).toEqual({ conflict: { message: 'Stale.' } });
    });
  });

  it('can keep flash data longer (reflash, keep) and flash input for old()', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => {
      session.flashData('a', 1);
      session.flashData('b', 2);
      session.flashInput({ name: 'Ada', email: 'x' });
    });
    await request(store, id, (session) => {
      expect(session.old('name')).toBe('Ada');
      expect(session.old()).toEqual({ name: 'Ada', email: 'x' });
      expect([session.old('toString'), session.old('constructor'), session.old('__proto__')]).toEqual([undefined, undefined, undefined]);
      session.flashData('_old_input', JSON.parse('{"__proto__":"x","a":{"__proto__":"y","b":1},"list":[{"__proto__":"z"}]}'));
      expect(session.old('__proto__')).toBeUndefined();
      expect(JSON.stringify(session.old())).toBe('{"a":{"b":1},"list":[{}]}');
      session.keep('a');
    });
    await request(store, id, (session) => {
      expect([session.get('a'), session.get('b')]).toEqual([1, undefined]);
      session.reflash();
    });
    await request(store, id, (session) => expect(session.get('a')).toBe(1));
  });

  it('flashes input like redirect().withInput(): no password field, no _token, no file — not even nested', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => {
      session.flashInput({
        email: 'ada@example.com',
        password: 'secret',
        new_password: 'new',
        Password: 'x',
        _token: 'csrf',
        avatar: new File(['x'], 'a.png'),
        nested: { current_password: 'deep', name: 'n' },
      });
    });
    const kept = JSON.stringify(await stored(store, id));
    expect(kept, kept).not.toMatch(/secret|csrf|deep|password|_token|avatar/i);
    await request(store, id, (session) => expect(session.old()).toEqual({ email: 'ada@example.com', nested: { name: 'n' } }));
  });

  describe('with names added to the redactor', () => {
    const flashed = { name: 'Ada', national_id: 'X', person: { National_ID: 'Y', city: 'Z' }, list: [{ national_id: 'W', ok: 1 }, 'plain'], remember: 'on' };
    const expected = { name: 'Ada', person: { city: 'Z' }, list: [{ ok: 1 }, 'plain'], remember: 'on' };
    const sessionWith = (redactor: Redactor | undefined) => new Session(new MemorySessionStore(), config, plainSessionCodec, redactor);

    it('leaves their fields out of flashed input at any depth and keeps the rest', async () => {
      const store = new MemorySessionStore();
      const first = new Session(store, config, plainSessionCodec, new Redactor({ keys: ['national_id'] }));
      await first.start(undefined);
      first.flashInput(flashed);
      await first.save();
      const kept = JSON.stringify(await stored(store, first.id));
      expect(kept, kept).not.toMatch(/national_id|"X"|"Y"|"W"/i);
      await request(store, first.id, (session) => expect(session.old()).toEqual(expected));
    });

    it('filters what is flashed under the input key in any other way, too', async () => {
      const session = sessionWith(new Redactor().addKeys('national_id'));
      await session.start(undefined);
      session.flashData('_old_input', flashed);
      expect(session.old()).toEqual(expected);
    });

    it('keeps a value with toJSON as its JSON form, like the store writes it', async () => {
      const session = sessionWith(new Redactor({ keys: ['national_id'] }));
      await session.start(undefined);
      session.flashData('_old_input', { born: new Date('2000-01-02T00:00:00Z'), national_id: 'X' });
      expect(session.old()).toEqual({ born: '2000-01-02T00:00:00.000Z' });
    });

    it('changes nothing without added names, and does not use the core list', async () => {
      for (const redactor of [undefined, new Redactor()]) {
        const session = sessionWith(redactor);
        await session.start(undefined);
        session.flashData('_old_input', flashed);
        expect(session.old()).toEqual(flashed);
      }
      const added = sessionWith(new Redactor({ keys: ['national_id'] }));
      await added.start(undefined);
      added.flashData('_old_input', { token: 'kept', national_id: 'X' });
      expect(added.old()).toEqual({ token: 'kept' });
    });
  });

  it('keeps a stored session small when a huge input is flashed: nothing above 64 KiB', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.flashInput({ email: 'ada@example.com', body: 'x'.repeat(8 * 1024 * 1024) }));
    expect(JSON.stringify(await stored(store, id)).length).toBeLessThan(1024);
    await request(store, id, (session) => expect(session.old()).toEqual({ email: 'ada@example.com' }));
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`field${index}`, 'v'.repeat(1000)]));
    const second = await request(store, undefined, (session) => session.flashInput(many));
    // Only the empty input is stored, not the 70 KB.
    expect(JSON.stringify(await stored(store, second.id)).length).toBeLessThan(1024);
    await request(store, second.id, (session) => expect(session.old()).toEqual({}));
  });

  it('regenerates the id and token but keeps the data — and destroys the old id (session fixation)', async () => {
    const store = new MemorySessionStore();
    const planted = await request(store, undefined, (session) => session.put('visits', 3));
    const token = planted.token();
    const login = await request(store, planted.id, (session) => {
      session.regenerate();
      session.put('user_id', '1');
    });

    expect(login.id).not.toBe(planted.id);
    expect(login.token()).not.toBe(token);
    expect(await stored(store, planted.id)).toBeUndefined();
    await request(store, login.id, (session) => expect(session.all()).toEqual({ visits: 3, user_id: '1' }));
  });

  it('invalidates everything on logout', async () => {
    const store = new MemorySessionStore();
    const before = await request(store, undefined, (session) => session.put('user_id', '1'));
    const after = await request(store, before.id, (session) => session.invalidate());
    expect(after.id).not.toBe(before.id);
    await request(store, after.id, (session) => expect(session.get('user_id')).toBeUndefined());
  });

  it('never writes back a session another request destroyed meanwhile — a sign-out stays a sign-out', async () => {
    const store = new MemorySessionStore();
    const signedIn = await request(store, undefined, (session) => session.put('user_id', '1'));

    // A slow request (a page's deferred props) starts with the signed-in session …
    const slow = new Session(store, config, plainSessionCodec);
    await slow.start(signedIn.id);
    // … the sign-out overtakes it …
    const signedOut = await request(store, signedIn.id, (session) => session.invalidate());
    // … and then the slow one finishes: nothing written, the old id stays gone.
    expect(await slow.save()).toBe(false);
    expect(await stored(store, signedIn.id)).toBeUndefined();
    expect((await request(store, signedIn.id)).get('user_id')).toBeUndefined();
    expect(await stored(store, signedOut.id)).toBeDefined();
  });

  it('keeps the CSRF token stable across requests', async () => {
    const store = new MemorySessionStore();
    let token = '';
    const first = await request(store, undefined, (session) => (token = session.token())); // handed out, like a page does
    expect(token).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect((await request(store, first.id)).token()).toBe(token);
  });

  it('does not write a new session that holds nothing — data, flash or a handed-out token keep it', async () => {
    const store = new MemorySessionStore();
    const writes: string[] = [];
    const counting = wrapped(store, { write: async (key, data, options) => (writes.push(key), store.write(key, data, options)) });
    const save = async (use: (session: Session) => void = () => {}) => {
      const session = new Session(counting, config, plainSessionCodec);
      await session.start(undefined);
      use(session);
      return { saved: await session.save(), persists: session.persists };
    };
    // A health check, a bot, an API call: nothing used — nothing written (and StartSession sends no cookie).
    expect(await save()).toEqual({ saved: false, persists: false });
    expect(await save((session) => (session.get('user_id'), session.id, session.regenerateToken()))).toEqual({ saved: false, persists: false });
    // A sign-out without a session: a new id, still nothing in it.
    expect(await save((session) => session.invalidate())).toEqual({ saved: false, persists: false });
    expect(writes).toEqual([]);
    // Worth keeping: data, flash data, a flash message, a token in the response (every page, a form).
    expect(await save((session) => session.put('visits', 1))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.flashData('status', 'Saved.'))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.queueFlash({ id: '1', key: 'toast', data: {} }))).toEqual({ saved: true, persists: true });
    expect(await save((session) => session.token())).toEqual({ saved: true, persists: true });
    expect(writes).toHaveLength(4);
  });

  it('draws a CSRF token only when something needs it — a new session that hands none out has none; sign-in renews it', async () => {
    const store = new MemorySessionStore();
    // A guest's request: no token made, none stored.
    const guest = await request(store, undefined, (session) => expect(session.currentToken(), 'a new session drew a token at start').toBeUndefined());
    expect(guest.currentToken()).toBeUndefined();
    // Data without a token (a failed form's errors): stored without one — the next request that needs it makes it, once.
    const kept = await request(store, undefined, (session) => session.put('visits', 1));
    expect(await stored(store, kept.id)).toEqual({ visits: 1, _v: 1 });
    const handed = await request(store, kept.id, (session) => {
      expect(session.currentToken()).toBeUndefined();
      expect(session.token()).toMatch(/^[A-Za-z0-9_-]{40}$/);
      expect(session.token()).toBe(session.currentToken()); // made once
    });
    const token = (await stored(store, kept.id))!._token;
    expect(token).toBe(handed.currentToken());
    await request(store, kept.id, (session) => expect(session.token()).toBe(token)); // and kept
    // A sign-in (regenerate) and a sign-out (invalidate) renew it at once.
    const signedIn = await request(store, kept.id, (session) => session.regenerate());
    expect(signedIn.currentToken()).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect(signedIn.currentToken()).not.toBe(token);
  });

  it('writes a loaded session back in one atomic step (compare-and-set on its version) — no read before it', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.put('visits', 1));
    const calls: string[] = [];
    const watched = wrapped(store, {
      read: (key) => (calls.push('read'), store.read(key)),
      write: (key, data, options) => (calls.push(`write@${options.expectedVersion}`), store.write(key, data, options)),
      destroy: (key) => (calls.push('destroy'), store.destroy(key)),
    });
    await request(watched, id, (session) => session.put('visits', 2));
    expect(calls).toEqual(['read', 'write@1']); // the load, then the write-back over the version it loaded
    calls.length = 0;
    // A sign-in: the old id goes, the NEW id is written as a new key (no version) — a write back would find nothing under it.
    const signedIn = await request(watched, id, (session) => {
      session.regenerate();
      session.put('user_id', '1');
    });
    expect(calls).toEqual(['read', 'destroy', 'write@undefined']);
    expect(await stored(store, signedIn.id)).toMatchObject({ visits: 2, user_id: '1' });
    expect(await store.read(sessionKey(id))).toBeUndefined();
  });

  it('a session other requests write without pause: save() gives up after a while — no endless retry, nothing written, said', async () => {
    const store = new MemorySessionStore();
    const { id } = await request(store, undefined, (session) => session.put('visits', 1));
    let writes = 0;
    // Every write meets a newer version: another request always got there first.
    const busy = wrapped(store, {
      read: async (key) => {
        const current = await store.read(key);
        return current && { data: JSON.stringify({ ...JSON.parse(current.data), elsewhere: writes }), version: current.version + writes };
      },
      write: async () => (writes++, 'conflict'),
    });
    const session = new Session(busy, config, plainSessionCodec);
    await session.start(id);
    session.put('visits', 2);
    // No stopwatch: an endless retry would end the test by its timeout instead of the answer.
    expect(await session.save()).toBe(false);
    expect(session.abandoned).toBe(true);
    expect(writes).toBeGreaterThan(3);
    expect(JSON.parse((await store.read(sessionKey(id)))!.data)).toMatchObject({ visits: 1 });
  });

  it('stores a session under the SHA-256 of its id — never the id', async () => {
    const store = new MemorySessionStore();
    const keys: string[] = [];
    const watched = wrapped(store, { write: (key, data, options) => (keys.push(key), store.write(key, data, options)) });
    const { id } = await request(watched, undefined, (session) => session.put('visits', 1));
    expect(keys).toEqual([sessionKey(id)]);
    expect(sessionKey(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.read(id)).toBeUndefined();
    // The key as a cookie value is no session: a store's keys sign nobody in.
    const replayed = await request(store, sessionKey(id));
    expect(replayed.id).not.toBe(sessionKey(id));
    expect(replayed.get('visits')).toBeUndefined();
  });

  it('explains a missing StartSession', () => {
    expect(() => new Session(new MemorySessionStore(), config, plainSessionCodec).get('user_id')).toThrow('add the StartSession middleware');
  });

  it('as the Flasher of a route without StartSession: redirect().with() and .flash() name the route and the web group', () => {
    const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
    const api = new Request('http://app.test/api/notes', { method: 'POST' });
    const message = (what: string) =>
      `${what} needs a session, and POST /api/notes runs without one: StartSession is not among its middleware. Put the route in the web group (an API route has none), or add StartSession to its group.`;
    expect(() => new RedirectResult('/').with('status', 'Saved.').toResponse(api, { routes: new Router(), flasher: session })).toThrow(message('redirect().with()'));
    expect(() => new RedirectResult('/').flash('toast', 'Saved.' as never).toResponse(api, { routes: new Router(), flasher: session })).toThrow(message('redirect().flash()'));
    // Without data to keep it needs none: intended() goes to its fallback.
    expect(new RedirectResult('/notes').intended().toResponse(api, { routes: new Router(), flasher: session }).headers.get('location')).toBe('/notes');
  });

  it('types declared keys and leaves the rest unknown', async () => {
    const session = await request(new MemorySessionStore(), undefined);
    expectTypeOf(session.get('user_id')).toEqualTypeOf<string | undefined>();
    expectTypeOf(session.get('anything')).toEqualTypeOf<unknown>();
    // @ts-expect-error -- user_id is declared as a string
    session.put('user_id', 1);
    session.put('anything', { free: 'form' });
  });
});

describe('session stores', () => {
  const directory = () => tempDir('marmeon-sessions-');

  it('file: survives a restart (a new store instance), writes atomically, private files', async () => {
    const dir = directory();
    const { id } = await request(new FileSessionStore(dir), undefined, (session) => session.put('user_id', '7'));

    const restarted = new FileSessionStore(join(dir)); // like a new process
    await request(restarted, id, (session) => expect(session.get('user_id')).toBe('7'));
    expect(readdirSync(dir)).toEqual([sessionKey(id)]); // named by the key, no temporary files or guards left
    expect(statSync(join(dir, sessionKey(id))).mode & 0o777).toBe(0o600);
  });

  it('file: expires by lifetime and garbage-collects old files', async () => {
    const dir = directory();
    const store = new FileSessionStore(dir);
    await store.write('a'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    expect(await store.read('a'.repeat(64))).toBeUndefined();

    await store.write('b'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, 'b'.repeat(64)), past, past);
    expect(await store.gc(60)).toBe(1); // by modification time
    expect(existsSync(join(dir, 'a'.repeat(64)))).toBe(true); // expired by its data, collected once it is old
    expect(existsSync(join(dir, 'b'.repeat(64)))).toBe(false);
  });

  it('file: writes back in place without ever losing the session — racing writes and reads of long and short records', async () => {
    const store = new FileSessionStore(directory());
    const key = 'd'.repeat(64);
    await store.write(key, '', { expectedVersion: undefined, lifetimeSeconds: 60 });
    const records = Array.from({ length: 60 }, (_, i) => JSON.stringify({ round: i, note: (i % 2 === 0 ? 'long ' : 's').repeat(i % 2 === 0 ? 100_000 : 1) }));
    // Each writer writes over the version it read, again until it lands: in place, under the guard.
    const writeUntilWritten = async (data: string) => {
      for (;;) {
        const current = await store.read(key);
        if ((await store.write(key, data, { expectedVersion: current!.version, lifetimeSeconds: 60 })) === 'written') return true;
      }
    };
    const [written, read] = await Promise.all([Promise.all(records.map(writeUntilWritten)), Promise.all(records.map(() => store.read(key)))]);
    expect(written.every(Boolean)).toBe(true);
    // A reader that meets a write in progress reads again; whatever order the writes landed in, one whole record is left.
    expect(read.filter((data) => data === undefined)).toEqual([]);
    const last = await store.read(key);
    expect(records).toContain(last!.data);
    expect(last!.version).toBe(61);
    // Sixty writers racing over one record lose some sixty races, about 300 reads of up to 500 KB (the writers', the readers' and the
    // guarded check in each write): the time is the work itself. A writer stuck behind the guard fails at the store's
    // GUARD_TIMEOUT_MS (10 s) with its own error; this timeout lies above it, so that error is what a stuck writer reports.
  }, 30_000);

  it('file: refuses keys that are not session keys (SHA-256 hex) — a raw session id included', async () => {
    await expect(new FileSessionStore(directory()).destroy('../escape')).rejects.toThrow('Invalid session key');
    await expect(new FileSessionStore(directory()).read('A'.repeat(40))).rejects.toThrow('Invalid session key');
  });

  it('memory: expires by lifetime', async () => {
    const store = new MemorySessionStore();
    await store.write('c'.repeat(64), '{}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    expect(await store.read('c'.repeat(64))).toBeUndefined();
    expect(await store.gc()).toBe(1);
  });
});

describe('Session — read-only (an island)', () => {
  it('asks before every write: a lenient lock drops it (production), the session is never saved', async () => {
    const store = new MemorySessionStore();
    const id = (await request(store, undefined, (session) => session.flashData('visits', 1))).id;
    const asked: string[] = [];
    const session = new Session(store, config, plainSessionCodec);
    await session.start(id);
    session.lock((what) => (asked.push(what), false));
    expect(session.readOnly).toBe(true);
    session.put('visits', 2);
    session.flashData('user_id', 'x');
    session.forget('visits');
    session.forget('nothing-there'); // changes nothing — not even asked
    session.regenerate();
    expect(session.id).toBe(id);
    expect(session.get('visits')).toBe(1);
    expect(asked).toEqual(["session.put('visits')", "session.flashData('user_id')", "session.forget('visits')", 'session.regenerate()']);
    expect(await session.save()).toBe(false);
    // The flash data is still there for the page it was meant for — not aged by the island's request.
    let seen: unknown;
    await request(store, id, (page) => (seen = page.get('visits')));
    expect(seen).toBe(1);
  });

  it('a strict lock (development) throws where the write is made', async () => {
    const session = new Session(new MemorySessionStore(), config, plainSessionCodec);
    await session.start(undefined);
    session.lock((what) => {
      throw new Error(`no: ${what}`);
    });
    expect(() => session.put('visits', 1)).toThrow("no: session.put('visits')");
  });
});

// Type guarantees (never called — checked by the build): a store says what its compare-and-set did.
function storeContract() {
  class Legacy extends SessionStore {
    async read() { return undefined; }
    // @ts-expect-error -- a store with writeIfExists and payload objects is no SessionStore
    async write() {}
    async writeIfExists() { return true; }
    async destroy() {}
    async gc() { return 0; }
  }
  const store: SessionStore = new MemorySessionStore();
  // @ts-expect-error -- a payload is text (JSON, or encrypted) — the store never sees an object
  void store.write('k', { user: 1 }, { expectedVersion: 1, lifetimeSeconds: 60 });
  // @ts-expect-error -- a write says what it did: written, conflict or gone — not a boolean
  const written: Promise<boolean> = store.write('k', '{}', { expectedVersion: 1, lifetimeSeconds: 60 });
  // @ts-expect-error -- the expected version is required: undefined for a new key, said out loud
  void store.write('k', '{}', { lifetimeSeconds: 60 });
  return [Legacy, written];
}
void storeContract;

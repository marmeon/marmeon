import type { Auth } from '@marmeon/auth';
import { notificationsChannel } from '@marmeon/live';
import { createTestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { NotificationsLiveAuthorizer } from './NotificationsLiveAuthorizer.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

const as = (user: { id: number } | undefined) => new NotificationsLiveAuthorizer({ user: async () => user } as unknown as Auth);

describe('who may follow a notifications channel', () => {
  it('only the account it belongs to — a guest or another account is refused, other channels are left to their pages', async () => {
    const ada = { id: 7 };
    const mine = notificationsChannel({ type: 'user', id: 7 });
    expect(await as(ada).allows(mine)).toBe(true);
    expect(await as({ id: 8 }).allows(mine)).toBe(false);
    expect(await as(undefined).allows(mine)).toBe(false);
    expect(await as(ada).allows(notificationsChannel({ type: 'user', id: 77 }))).toBe(false);
    expect(await as(ada).allows('dashboard.sign-ins')).toBe(true);
  });

  it('is listed by the module, and the bell of a signed-in user still gets its stream', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create();
    const stream = await app.actingAs(ada).live('/notifications');
    expect(Object.keys((await stream.hello()).seq)).toEqual([notificationsChannel({ type: 'user', id: ada.id })]);
  });
});

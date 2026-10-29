import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

// A repository stamps created_at and updated_at with the app's clock, so a test that moves time sees the stamps move.

const DAY = 86_400_000;

describe('the stamps of a row follow the app clock', () => {
  it('a row made after app.travel() is stamped with the travelled time, and an update moves updated_at only', async () => {
    const app: TestApp = await createTestApp(application, { database: 'refresh' });
    app.freeze();
    const start = app.clock.now();
    app.travel({ days: 7 });
    const user = await app.factory(UserFactory).create();
    expect(new Date(user.created_at as string).getTime()).toBe(start + 7 * DAY);
    expect(new Date(user.updated_at as string).getTime()).toBe(start + 7 * DAY);

    app.travel({ days: 1 });
    const updated = await app.make(UserRepository).update(user.id, { name: 'Renamed' });
    expect(new Date(updated!.created_at as string).getTime()).toBe(start + 7 * DAY);
    expect(new Date(updated!.updated_at as string).getTime()).toBe(start + 8 * DAY);
  });
});

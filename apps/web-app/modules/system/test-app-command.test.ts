import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

describe('app.command()', () => {
  it('runs a package command and returns its lines without colours', async () => {
    const app = await createTestApp(application);
    const run = await app.command('cache:clear');
    expect(run.code).toBe(0);
    expect(run.lines.join('\n')).toMatch(/Cleared the cache/);
    expect(run.lines.join('\n')).not.toContain('\u001B');
    await app.close();
  });

  it("runs the app's own command", async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const run = await app.command('auth:prune-unverified');
    expect(run.code).toBe(0);
    expect(run.lines.join('\n')).toMatch(/Deleted 0 accounts/);
    await app.close();
  });

  it('exits 2 for a name nobody has', async () => {
    const app = await createTestApp(application);
    const run = await app.command('cache:clean');
    expect(run.code).toBe(2);
    expect(run.lines.join('\n')).toContain('Command "cache:clean" is not defined');
    await app.close();
  });

  it('exits 2 for a flag the command does not declare', async () => {
    const app = await createTestApp(application);
    const run = await app.command('cache:clear', { options: { nope: true } });
    expect(run.code).toBe(2);
    expect(run.lines.join('\n')).toContain('Usage: marmeon cache:clear');
    await app.close();
  });

  it('returns exit 2 for arguments the command refuses instead of throwing', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const run = await app.command('queue:retry');
    expect(run.code).toBe(2);
    expect(run.lines.join('\n')).toContain('Pass the ids of the failed jobs');
    await app.close();
  });
});

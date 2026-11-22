import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// @marmeon/queue is an optional peer of the scheduler: an app without it must still load the entry and start `schedule:work`.
it('loads its entry and checks job names in a process that cannot resolve @marmeon/queue', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const asked = [];
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === '@marmeon/queue') asked.push(context.parentURL);
      if (specifier === '@marmeon/queue') throw Object.assign(new Error("Cannot find package '@marmeon/queue'"), { code: 'ERR_MODULE_NOT_FOUND' });
      return next(specifier, context);
    } });
    await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
    const { warnJobNames } = await import(${JSON.stringify(new URL('./job-names.ts', import.meta.url).href)});
    const commandOnly = { name: 'c', definition: { kind: 'command', target: 'x' } };
    const never = { make: () => { throw new Error('made'); } };
    await warnJobNames([commandOnly], { container: never }, () => { throw new Error('line'); });
    const askedForCommands = asked.length;
    const blocked = await import('@marmeon/queue').then(() => 'resolvable', () => 'blocked');
    const lines = [];
    const task = { name: 't', definition: { kind: 'job', target: class {}, environments: undefined } };
    await warnJobNames([task], { container: { make: () => ({ environment: 'test' }), has: () => true } }, (text) => lines.push(text));
    process.stdout.write(JSON.stringify({ askedForCommands, askedTotal: asked.length, blocked, lines }));
  `;
  const said = execFileSync(process.execPath, ['--conditions=@marmeon/source', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  expect(JSON.parse(said)).toEqual({ askedForCommands: 0, askedTotal: 2, blocked: 'blocked', lines: [] });
}, 30_000);

import { fileURLToPath } from 'node:url';
import { PublishCommand } from '@marmeon/database';
import type { CommandInput } from 'marmeon';
import { expect, it } from 'vitest';

// The app shows what `marmeon check` asks of every app: the migrations of the packages it publishes from are in it.
it('has every migration of the packages it uses', async () => {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const code = await new PublishCommand().handle({ root, args: [], options: { check: true }, output } as unknown as CommandInput);
  expect(lines).toEqual(['✓ Every package you publish from has its migrations in your app']);
  expect(code).toBe(0);
});

import { join } from 'node:path';
import { Application } from '@marmeon/core';
import { MakeUpgradeMigrationsCommand } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import type { CommandInput } from 'marmeon';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// The migrations of the framework's tables in this app are the ones the installed packages bring: a release that changes a
// table fails here until `marmeon make:upgrade-migrations` has written its migration into the app.
it('has every migration of the framework’s tables', async () => {
  const app = await createTestApp(application);
  const lines: string[] = [];
  const output = { success: (line: string) => lines.push(line), error: (line: string) => lines.push(line), warn: (line: string) => lines.push(line), line: (line = '') => lines.push(line) };
  const root = join(import.meta.dirname, '../..');
  const code = new MakeUpgradeMigrationsCommand(app.make(Application)).handle({ root, args: [], options: { check: true }, output } as unknown as CommandInput);
  expect(lines).toEqual(["The framework's tables have every migration of the installed packages."]);
  expect(code).toBe(0);
});

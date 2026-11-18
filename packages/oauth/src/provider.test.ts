import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { SocialAccountsServiceProvider } from './accounts/index.ts';
import { MakeOAuthCommand } from './make-oauth.ts';
import { OAuthServiceProvider } from './provider.ts';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

describe('OAuthServiceProvider', () => {
  it('brings make:oauth', () => {
    expect(OAuthServiceProvider.commands).toContain(MakeOAuthCommand);
  });

  it('lets marmeon publish @marmeon/oauth copy the migration of social_accounts into the system module', async () => {
    // The real package, installed in an app the way `publish` reads it: through node_modules, with the providers the app boots.
    const root = workspaceTempDir('marmeon-oauth-publish-');
    mkdirSync(join(root, 'node_modules', '@marmeon'), { recursive: true });
    symlinkSync(PACKAGE, join(root, 'node_modules', '@marmeon', 'oauth'), 'dir');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@marmeon/oauth': '1.1.0' } }));
    const Publish = DatabaseServiceProvider.commands!.find((command) => command.command === 'publish')! as unknown as new (app: Application) => { handle(input: unknown): Promise<number> };
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), info: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const command = new Publish({ root, providers: [OAuthServiceProvider, SocialAccountsServiceProvider] } as unknown as Application);
    expect(await command.handle({ root, args: ['@marmeon/oauth'], options: {}, output, spawn: async () => 0 }), lines.join('\n')).toBe(0);
    // Nothing is unclaimed, and the one migration lands in `system`.
    expect(lines.filter((line) => line.includes('does not claim') || line.includes('ships no migrations'))).toEqual([]);
    expect(existsSync(join(root, 'modules/system/migrations'))).toBe(true);
    expect(readdirSync(join(root, 'modules/system/migrations')).map((file) => file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, ''))).toEqual(['create_social_accounts_table.ts']);
  });
});

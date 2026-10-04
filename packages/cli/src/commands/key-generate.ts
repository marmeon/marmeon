import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKey } from '@bespokecore/encryption';
import type { CommandInput } from '../command.ts';

/**
 * Writes a new `APP_KEY` into `.env` (Laravel's `key:generate`). Runs without
 * booting the app — a missing key is exactly why it cannot boot.
 *
 * `--force` replaces a key that is set — and moves the old one to the front of `APP_PREVIOUS_KEYS` (E169), so what it encrypted
 * or signed stays valid: the session cookie, encrypted session data (`SESSION_ENCRYPT`), other encrypted cookies, signed links
 * already sent. Remove old keys from `APP_PREVIOUS_KEYS` once nothing needs them.
 */
export class KeyGenerateCommand {
  static command = 'key:generate';
  static description = 'Set the application key (APP_KEY) in .env';
  static options = { show: { type: 'boolean' }, force: { type: 'boolean' } } as const;
  static boots = false;

  handle({ options, output, root }: CommandInput): number {
    const key = generateKey();
    if (options.show === true) {
      output.line(key);
      return 0;
    }

    const file = join(root, '.env');
    if (!existsSync(file) && existsSync(join(root, '.env.example'))) copyFileSync(join(root, '.env.example'), file);
    const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const line = /^APP_KEY=(.*)$/m.exec(env);

    if (line && line[1]!.trim() !== '' && options.force !== true) {
      output.error('APP_KEY is already set. Replacing it makes existing sessions and encrypted cookies unreadable — use --force.');
      return 1;
    }

    let next = line ? env.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`) : `${env}${env === '' || env.endsWith('\n') ? '' : '\n'}APP_KEY=${key}\n`;
    const old = line ? unquote(line[1]!) : '';
    if (old !== '') {
      // Rotation (E169): the old key keeps decrypting what it encrypted.
      const previous = /^APP_PREVIOUS_KEYS=(.*)$/m.exec(next);
      const keys = [old, ...(previous ? unquote(previous[1]!).split(',').map((value) => value.trim()) : [])].filter((value, index, all) => value !== '' && all.indexOf(value) === index);
      next = previous
        ? next.replace(/^APP_PREVIOUS_KEYS=.*$/m, `APP_PREVIOUS_KEYS=${keys.join(',')}`)
        : next.replace(/^APP_KEY=.*$/m, (current) => `${current}\nAPP_PREVIOUS_KEYS=${keys.join(',')}`);
    }
    writeFileSync(file, next);
    output.success('Application key set in .env.');
    if (old !== '') output.line('The old key moved to APP_PREVIOUS_KEYS: sessions, encrypted cookies and signed links stay valid. Set both on every server.');
    return 0;
  }
}

/** A `.env` value without its quotes. */
function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

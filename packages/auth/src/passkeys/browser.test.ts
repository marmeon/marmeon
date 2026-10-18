import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { base64UrlFromBuffer, bufferFromBase64Url } from './browser.ts';

// The converters the browser code falls back on where `parse…FromJSON` and `toJSON()` are missing.

const packages = fileURLToPath(new URL('../../../', import.meta.url));

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe('the base64url converters of the browser code', () => {
  it('turn bytes into base64url without padding and back', () => {
    // 0xfb 0xff 0xbe is "+/++" in base64: the URL-safe alphabet and no "=".
    expect(base64UrlFromBuffer(bytes(0xfb, 0xff, 0xbe))).toBe('-_--');
    expect(base64UrlFromBuffer(bytes(1, 2, 3, 4))).toBe('AQIDBA');
    expect([...new Uint8Array(bufferFromBase64Url('AQIDBA'))]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(bufferFromBase64Url('-_--'))]).toEqual([0xfb, 0xff, 0xbe]);
  });

  it('round-trip every length, the ones that need padding included', () => {
    for (let length = 0; length < 40; length++) {
      const original = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
      const text = base64UrlFromBuffer(original.buffer);
      expect(text).not.toMatch(/[+/=]/);
      expect([...new Uint8Array(bufferFromBase64Url(text))]).toEqual([...original]);
    }
  });

  it('give an empty string for no buffer (a missing user handle)', () => {
    expect(base64UrlFromBuffer(null)).toBe('');
  });
});

describe('@marmeon/auth/passkeys/browser is browser-safe', () => {
  it('bundles nothing but itself — no server code, no Node built-ins, no dependency', async () => {
    const externals = new Set<string>();
    const output = (await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { conditions: ['@marmeon/source', 'browser', 'module', 'import', 'default'] },
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('./browser.ts', import.meta.url)), formats: ['es'], fileName: 'entry' },
        rolldownOptions: {
          external: (id, importer) => {
            const bare = importer !== undefined && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0') && !id.startsWith('@marmeon/');
            if (bare || id.startsWith('node:')) {
              externals.add(id);
              return true;
            }
            return false;
          },
        },
      },
    })) as Rolldown.RolldownOutput[];
    const modules = new Set<string>();
    for (const { output: chunks } of output) {
      for (const chunk of chunks) if (chunk.type === 'chunk') for (const id of chunk.moduleIds) if (!id.startsWith('\0')) modules.add(relative(packages, id).replaceAll('\\', '/'));
    }
    expect([...externals]).toEqual([]);
    expect([...modules]).toEqual(['auth/src/passkeys/browser.ts']);
  }, 30_000);
});

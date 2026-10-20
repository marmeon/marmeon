import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { marmeon, repo } from '../__fixtures__/cli.js';

import { maxAgeOf } from './hsts.ts';

const blank =join(repo, 'apps/blank-app');

/** A catch-all route that writes what it was asked into `hits.log`, to prove who the probe reached. */
const CATCH_ALL = `
import { defineModule } from '@marmeon/core';
import { defineRoutes, everyone } from '@marmeon/router';
import { appendFileSync } from 'node:fs';
export default defineModule({
  name: 'catchall',
  routes: defineRoutes((Root) => {
    const Route = Root.authorize(everyone);
    Route.any('/:page{.+}', (ctx) => {
      appendFileSync(process.env.HITS_LOG!, JSON.stringify({ url: ctx.request.url, method: ctx.request.method, cookie: ctx.request.headers.get('cookie'), accept: ctx.request.headers.get('accept') }) + '\\n');
      return 'caught';
    });
  }),
});
`;

/** A global middleware that writes what each request looks like into `seen.log`. */
const SPY = `
import { appendFileSync } from 'node:fs';
export class Spy {
  async handle(ctx, next) {
    const { request } = ctx;
    appendFileSync(process.env.SEEN_LOG, JSON.stringify({ method: request.method, path: new URL(request.url).pathname, accept: request.headers.get('accept'), cookie: request.headers.has('cookie'), body: request.body !== null }) + '\\n');
    return next();
  }
}
`;

interface Options {
  /** A global middleware that logs each request to `seen.log`. */
  spy?: boolean;
  /** What `securityHeaders()` gets in `bootstrap/app.ts` (source text). */
  headers?: string;
  /** A module with a catch-all route that logs to `hits.log`. */
  catchAll?: boolean;
}

/** A copy of the blank app (SQLite) whose `bootstrap/app.ts` lists `securityHeaders(<headers>)`. */
function app({ headers = '', catchAll = false, spy = false }: Options = {}): string {
  const root = realpathSync(tempDir('marmeon-check-hsts-'));
  cpSync(blank, root, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
  symlinkSync(join(blank, 'node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(join(root, 'storage'));
  let entry = readFileSync(join(root, 'bootstrap/app.ts'), 'utf8').replace('securityHeaders()', `securityHeaders(${headers})`);
  if (catchAll) {
    writeFileSync(join(root, 'catchall.ts'), CATCH_ALL);
    entry = entry.replace("import { AppConfig }", "import catchall from '../catchall.ts';\nimport { AppConfig }").replace('modules: [system],', 'modules: [system, catchall],');
  }
  if (spy) {
    writeFileSync(join(root, 'spy.ts'), SPY);
    entry = entry.replace("import { AppConfig }", "import { Spy } from '../spy.ts';\nimport { AppConfig }").replace('global: [', 'global: [Spy, ');
  }
  writeFileSync(join(root, 'bootstrap/app.ts'), entry);
  return root;
}

const check = (root: string, args: string[], extra: Record<string, string> = {}) =>
  marmeon(
    root,
    ['check', '--json', ...args],
    { DB_DATABASE: join(root, 'storage/app.sqlite'), APP_KEY: generateKey(), APP_NAME: 'Mark', NODE_ENV: 'production', APP_URL: 'https://example.com', HITS_LOG: join(root, 'hits.log'), SEEN_LOG: join(root, 'seen.log'), ...extra },
    90_000,
  );
const hsts = (stdout: string) => (JSON.parse(stdout).checks as { name: string }[]).find((report) => report.name === 'hsts') as
  | { status: string; reason?: string; problems: { severity: string; message: string; rule: string; docs: string; file?: string }[] }
  | undefined;
const probe = (root: string, extra?: Record<string, string>) => {
  const { code, stdout } = check(root, ['--only=boot,hsts'], extra);
  return { code, report: hsts(stdout)! };
};

describe('maxAgeOf', () => {
  it('reads max-age as a browser does: any case, spaces, quotes, the first of several headers', () => {
    expect(maxAgeOf('max-age=31536000; includeSubDomains; preload')).toBe(31_536_000);
    expect(maxAgeOf('Max-Age=300')).toBe(300);
    expect(maxAgeOf('includeSubDomains ; MAX-AGE = 60')).toBe(60);
    expect(maxAgeOf('max-age="600"')).toBe(600);
    expect(maxAgeOf('max-age=0, max-age=31536000')).toBe(0);
    expect(maxAgeOf('max-age=31536000, max-age=0')).toBe(31_536_000);
  });

  it('finds none in a header a browser ignores', () => {
    expect(maxAgeOf('')).toBeUndefined();
    expect(maxAgeOf('includeSubDomains; preload')).toBeUndefined();
    expect(maxAgeOf('max-age=')).toBeUndefined();
    expect(maxAgeOf('max-age=soon')).toBeUndefined();
    expect(maxAgeOf('max-age=-1')).toBeUndefined();
    expect(maxAgeOf('max-age=10; max-age=20')).toBeUndefined();
  });
});

describe('hsts check', { timeout: 120_000 }, () => {
  it('warns when production on an https APP_URL sends no Strict-Transport-Security, and the exit code stays 0', () => {
    const { code, report } = probe(app());
    expect(code).toBe(0);
    expect(report.status).toBe('warning');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({
      severity: 'warning',
      rule: 'marmeon(hsts)',
      docs: 'docs/security.md#strict-transport-security',
      message: expect.stringContaining('securityHeaders({ hsts: … }) in bootstrap/app.ts'),
    });
    expect(report.problems[0]!.message).toContain('--skip=hsts');
    expect(report.problems[0]!.file).toBeNull();
  });

  it('passes when hsts is on', () => {
    const { report } = probe(app({ headers: '{ hsts: { maxAge: 31_536_000, includeSubDomains: true } }' }));
    expect(report).toMatchObject({ status: 'passed', problems: [] });
  });

  it('warns that max-age=0 turns HSTS off', () => {
    const { code, report } = probe(app({ headers: '{ hsts: { maxAge: 0 } }' }));
    expect(code).toBe(0);
    expect(report.status).toBe('warning');
    expect(report.problems[0]!.message).toContain('max-age=0, which turns HSTS off');
  });

  it('is skipped in development and test, naming how to run it', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const { code, report } = probe(app(), { NODE_ENV });
      expect(code).toBe(0);
      expect(report.status).toBe('skipped');
      expect(report.reason).toContain('NODE_ENV=production');
      expect(report.reason).toContain('--only=boot,hsts');
    }
  });

  it('is skipped when APP_URL is not https', () => {
    const { report } = probe(app(), { APP_URL: 'http://example.com' });
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('https');
  });

  it('is not in the report with --skip=hsts', () => {
    const { code, stdout } = check(app(), ['--only=boot,hsts', '--skip=hsts']);
    expect(code).toBe(0);
    expect(hsts(stdout)).toBeUndefined();
  });

  it('is not answered by a catch-all route of the app, yet passes through the global middleware', () => {
    const root = app({ catchAll: true, headers: '{ hsts: { maxAge: 31_536_000 } }' });
    expect(probe(root).report).toMatchObject({ status: 'passed', problems: [] });
    expect(existsSync(join(root, 'hits.log'))).toBe(false);
  });

  it('asks once: a GET of the reserved path with accept application/json, no cookie and no body', () => {
    const root = app({ spy: true });
    expect(probe(root).report.status).toBe('warning');
    const seen = readFileSync(join(root, 'seen.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(seen).toEqual([{ method: 'GET', path: '/_marmeon/hsts-probe', accept: 'application/json', cookie: false, body: false }]);
  });
});

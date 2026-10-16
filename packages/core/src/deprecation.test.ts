import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module per test: the set of ids already warned about lives in it. */
async function load(): Promise<typeof import('./deprecation.ts')> {
  vi.resetModules();
  return import('./deprecation.ts');
}

describe('deprecated', () => {
  let emit: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('warns in test with the type, the id as code, the message and the version', async () => {
    const { deprecated } = await load();
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(emit).toHaveBeenCalledTimes(1);
    const [text, options] = emit.mock.calls[0]!;
    expect(text).toContain('Use new instead.');
    expect(text).toContain('2.0');
    expect(options).toEqual({ type: 'DeprecationWarning', code: 'http.old' });
  });

  it('warns in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { deprecated } = await load();
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('warns once per id', async () => {
    const { deprecated } = await load();
    deprecated('http.old', 'Use new instead.', '2.0');
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(emit).toHaveBeenCalledTimes(1);
    deprecated('http.other', 'Use other instead.', '2.0');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it.each(['production', '', 'staging'])('stays silent when NODE_ENV is %j', async (value) => {
    vi.stubEnv('NODE_ENV', value);
    const { deprecated } = await load();
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when NODE_ENV is not set', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    const { deprecated } = await load();
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(emit).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to console.warn without process.emitWarning', async () => {
    const { deprecated } = await load();
    vi.stubGlobal('process', { env: process.env });
    deprecated('http.old', 'Use new instead.', '2.0');
    deprecated('http.old', 'Use new instead.', '2.0');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });
});

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { nodeCheck } from './check/node.ts';

interface Files {
  engines?: string;
  nvmrc?: string;
  nodeVersion?: string;
  /** The text of `package.json` itself, over the one built from `engines`. */
  manifest?: string;
}

/** An app root with the given `engines.node` (none: no `engines`) and version files. */
function app({ engines, nvmrc, nodeVersion, manifest }: Files = {}): string {
  const root = realpathSync(tempDir('marmeon-check-node-'));
  writeFileSync(join(root, 'package.json'), manifest ?? JSON.stringify({ name: 'shop', ...(engines === undefined ? {} : { engines: { node: engines } }) }));
  if (nvmrc !== undefined) writeFileSync(join(root, '.nvmrc'), nvmrc);
  if (nodeVersion !== undefined) writeFileSync(join(root, '.node-version'), nodeVersion);
  return root;
}
const own = (running: string, files: Files = {}, marmeon: string | null = '>=26.10') => nodeCheck(app(files), { running, marmeon }).report;

describe('nodeCheck', () => {
  it('fails below the bound of marmeon, naming both versions and the docs', () => {
    expect(own('26.9.0')).toMatchObject({
      name: 'node',
      status: 'failed',
      problems: [{ severity: 'error', message: 'Node 26.9.0 runs this; marmeon needs >=26.10', docs: 'docs/releases.md#node' }],
    });
  });

  it('fails below the bound of the app and names package.json', () => {
    const report = own('26.10.0', { engines: '>=27' });
    expect(report.status).toBe('failed');
    expect(report.problems[0]?.message).toBe('Node 26.10.0 runs this; package.json needs >=27');
  });

  it('fails on a difference in the patch only when the bound names it', () => {
    expect(own('26.10.0', { engines: '>=26.10.1' }).status).toBe('failed');
    expect(own('26.10.1', { engines: '>=26.10.1' }).status).toBe('passed');
  });

  it('passes on the bound itself and above it', () => {
    expect(own('26.10.0', { engines: '>=26.10.0' }).status).toBe('passed');
    expect(own('27.1.2', { engines: '>=26' }).status).toBe('passed');
  });

  it('judges a prerelease or nightly Node on its three numbers', () => {
    expect(own('27.0.0-nightly20261117abcdef0123').status).toBe('passed');
    expect(own('26.10.0-rc.1').status).toBe('passed');
    expect(own('26.9.0-rc.1').status).toBe('failed');
  });

  it('is an error, not a finding, when the running version cannot be read', () => {
    expect(own('banana')).toMatchObject({ status: 'error', reason: 'the version of this Node is not readable: banana' });
  });

  it('reads the engines of the running marmeon package when none is given', () => {
    expect(nodeCheck(app(), { running: '1.0.0' }).report.status).toBe('failed');
    expect(nodeCheck(app()).report.status).toBe('passed');
  });

  it.each(['^26', '>28', '28', '>=v28', '>=20 <30'])('warns about the range %s, which it does not judge, and fails nothing', (range) => {
    const report = own('20.0.0', { engines: range }, null);
    expect(report).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: `package.json asks for "${range}", a range this check does not judge` }] });
  });

  it('warns about an unjudged range beside a judged one', () => {
    expect(own('26.10.0', { engines: '>=20 <30' })).toMatchObject({ status: 'warning', problems: [{ severity: 'warning' }] });
  });

  it('warns, and fails nothing, when package.json is a directory, null or broken', () => {
    const directory = realpathSync(tempDir('marmeon-check-node-'));
    mkdirSync(join(directory, 'package.json'));
    expect(nodeCheck(directory, { running: '26.10.0', marmeon: null }).report).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: expect.stringContaining('package.json could not be read') }] });
    for (const manifest of ['null', '{']) {
      expect(own('26.10.0', { manifest }, null)).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: expect.stringContaining('package.json could not be read') }] });
    }
  });

  it('is skipped with a reason when there is no source at all', () => {
    expect(own('26.10.0', {}, null)).toMatchObject({ status: 'skipped', reason: 'no Node version to compare with', problems: [] });
  });

  it('warns when .nvmrc asks for another version than the one that runs', () => {
    expect(own('27.0.0', { nvmrc: '26\n' })).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: 'Node 27.0.0 runs this; .nvmrc asks for 26' }] });
  });

  it('compares .node-version on the parts it gives and accepts a leading v', () => {
    expect(own('26.10.4', { nodeVersion: 'v26.10\n' }).status).toBe('passed');
    expect(own('26.11.0', { nodeVersion: 'v26.10\n' }).status).toBe('warning');
  });

  it('reads .nvmrc and leaves .node-version alone when both exist', () => {
    expect(own('27.0.0', { nvmrc: '27', nodeVersion: '26' }).status).toBe('passed');
    expect(own('27.0.0', { nvmrc: '26', nodeVersion: '27' }).status).toBe('warning');
  });

  it('ignores an alias in .nvmrc, and then does not read a mismatching .node-version', () => {
    expect(own('27.0.0', { nvmrc: 'lts/*', nodeVersion: '26' }).status).toBe('passed');
  });

  it.each(['lts/*', 'lts/iron', 'lts/-1', 'node', 'latest', 'stable'])('ignores the alias %s silently', (alias) => {
    expect(own('27.0.0', { nvmrc: alias })).toMatchObject({ status: 'passed', problems: [] });
  });

  it('warns about a version file that is no version and no alias', () => {
    expect(own('28.0.0', { nvmrc: '28 # prod' })).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', message: '.nvmrc holds "28 # prod", which is no version or alias this check knows' }] });
  });

  it('cuts the text of a range or a version file that it echoes in a message', () => {
    const long = 'x'.repeat(5000);
    for (const files of [{ engines: long }, { nvmrc: long }]) {
      const report = own('28.0.0', files, null);
      expect(report.status).toBe('warning');
      expect(report.problems[0]!.message.length).toBeLessThan(200);
    }
  });
});

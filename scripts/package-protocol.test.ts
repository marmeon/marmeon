import { describe, expect, it } from 'vitest';
import { documentedClassStatics, documentedStatics, packageSources, pageText, protocolProblems, providerStatics, repositoryStatics, startupStatics } from './package-protocol.ts';

const core = `export interface ServiceProviderClass {\n  new (...args: any[]): object;\n  readonly config?: unknown;\n  readonly health?: unknown;\n}`;
const extension = (name: string) =>
  `declare module '@marmeon/core' {\n  interface ModuleDefinition {\n    readonly routes?: unknown;\n  }\n  interface ServiceProviderClass {\n    readonly ${name}?: unknown;\n  }\n}`;
const table = (...names: string[]) =>
  `### Provider statics\n\n| Static | Type |\n| --- | --- |\n${names.map((name) => `| \`${name}\` | x |`).join('\n')}\n\n### Statics of other classes\n\n| \`inject\` | y |`;

describe('the package protocol page', () => {
  it('lists exactly the statics of ServiceProviderClass that the packages declare', () => {
    expect(protocolProblems(packageSources(), pageText())).toEqual([]);
  });

  it('lists the statics that the K9 message names, each one a row of the table', () => {
    expect(startupStatics()).toEqual(documentedStatics(pageText()));
  });

  it('names the statics of controllers and repositories in the table of other classes', () => {
    const documented = documentedClassStatics(pageText());
    expect(repositoryStatics(packageSources())).toEqual(['connection', 'routeKey', 'routeKeyPattern', 'table']);
    for (const name of [...repositoryStatics(packageSources()), 'request']) expect(documented.has(name), name).toBe(true);
  });

  it('finds the statics in the core and in the extensions of the packages, not those of a module definition or a test', () => {
    const files = [
      { path: 'packages/core/src/provider.ts', text: core },
      { path: 'packages/queue/src/index.ts', text: extension('queueDrivers') },
      { path: 'packages/queue/src/index.test.ts', text: extension('ignored') },
    ];
    expect(providerStatics(files)).toEqual(['config', 'health', 'queueDrivers']);
  });

  it('reads the rows of the table and stops at the next heading', () => {
    expect(documentedStatics(table('health', 'config'))).toEqual(['config', 'health']);
  });

  it('names a static the table lacks and one it lists without the code declaring it', () => {
    const files = [
      { path: 'packages/core/src/provider.ts', text: core },
      { path: 'packages/queue/src/index.ts', text: extension('queueDrivers') },
    ];
    expect(protocolProblems(files, table('config', 'health'))).toEqual([expect.stringContaining('lacks `queueDrivers`')]);
    expect(protocolProblems(files, table('config', 'health', 'queueDrivers', 'ghost'))).toEqual([expect.stringContaining('lists `ghost`')]);
    expect(protocolProblems(files, '## Nothing')).toEqual([expect.stringContaining('no table')]);
  });
});

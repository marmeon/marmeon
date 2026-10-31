import { ConfigError } from './config/config.ts';
import { ContainerError } from './container.ts';
import { InjectionError } from './injection/analyze.ts';
import { withoutCode } from './error-codes.ts';
import { defineSolutions, type Solution } from './solutions.ts';

const CONTAINER_DOCS = 'docs/container.md#the-containers-errors';

/** The core's own solutions: the container, the injection transform, the configuration. Always registered. */
export const coreSolutions = defineSolutions([
  {
    for: ContainerError,
    code: 'K1',
    when: (e) => e.reason === 'unbound',
    solve: (e) => ({
      title: `Bind ${e.key} in a service provider`,
      text:
        `Nothing is bound for ${e.key}${e.neededBy ? ` (needed by ${e.neededBy})` : ''}. An interface's token needs a binding: ` +
        `register one in a provider's register() — container.singleton(${e.key}, Implementation). If a package provides it, ` +
        'install the package and let discovery register its provider.',
      command: 'marmeon discover',
      docs: CONTAINER_DOCS,
    }),
  },
  {
    for: ContainerError,
    code: 'K2',
    when: (e) => e.reason === 'scoped',
    solve: (e) => ({
      title: e.neededBy ? `Do not resolve the scoped ${e.key} from a singleton` : `Resolve ${e.key} inside a scope`,
      text: e.neededBy
        ? `${e.key} lives per request (scoped), but ${e.neededBy} is built once for the whole app and would keep the first ` +
          `request's ${e.key}. Bind ${e.path[0]} as scoped too, or inject what it needs per call instead.`
        : `${e.key} lives per request (scoped). Resolve it from the request's scope — inject it into a controller, ` +
          'middleware or listener — or from app.container.createScope() in a command or a test.',
      docs: CONTAINER_DOCS,
    }),
  },
  {
    for: ContainerError,
    code: 'K3',
    when: (e) => e.reason === 'no-injection-list',
    solve: (e) => injectionSolution(e.key ?? 'The class', e.injection),
  },
  {
    for: ContainerError,
    code: 'K4',
    when: (e) => e.reason === 'circular',
    solve: (e) => ({
      title: 'Break the circular dependency',
      text:
        `${[...e.path, e.key].join(' → ')}: each class needs the next to be built first, so none can be. Move what both ` +
        'need into a third class, or let one of them take the other per call (a method parameter) instead of in its constructor.',
      docs: CONTAINER_DOCS,
    }),
  },
  {
    for: ContainerError,
    code: 'K16',
    when: (e) => e.reason === 'undefined-dependency',
    solve: (e) =>
      e.madeUndefined
        ? {
            title: 'Find the import cycle behind the undefined class',
            text:
              `make() was given undefined${e.path.length ? ` (needed by ${e.path.at(-1)})` : ''}: the class was not defined yet when it was imported, ` +
              'usually because two modules import each other. Let one of them read what the other exposes (a table, an abstract class) instead of importing its class.',
            docs: CONTAINER_DOCS,
          }
        : {
            title: `Find the import cycle behind ${e.key}`,
            text:
              `${e.key} lists a dependency that is undefined: the class was not defined yet when ${e.key} was, usually because two ` +
              'modules import each other. Let one of them read what the other exposes (a table, an abstract class) instead of importing its class.',
            docs: CONTAINER_DOCS,
          },
  },
  {
    for: InjectionError,
    code: 'K5',
    solve: (e) => injectionSolution('The class', withoutCode(e.message)),
  },
  {
    // A module's entry (#modules/<name>) is loaded as server code; Node has no loader for a component file.
    for: Error,
    when: (e) => (e as { code?: unknown }).code === 'ERR_UNKNOWN_FILE_EXTENSION' && e.message.includes('.tsx'),
    solve: () => ({
      title: "A module's entry reached a component",
      text:
        "Node loads a module's entry (`#modules/<name>`) as server code, and a `.tsx` file cannot be loaded there. Components several " +
        'modules share get an import of their own (an `imports` entry in package.json), which views import directly.',
      docs: 'docs/structure.md#components-several-modules-share',
    }),
  },
  {
    // Node refuses TypeScript under node_modules: a package that reaches Node with its sources instead of its dist/.
    for: Error,
    when: (e) => (e as { code?: unknown }).code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
    solve: (e) => ({
      title: 'Install the package as it is published',
      text:
        `Node does not run TypeScript under node_modules (${/for "([^"]+)"/.exec(e.message)?.[1] ?? 'a package'}). A published package ` +
        'brings its built dist/ — this one points Node at its sources: packed with npm pack (which ignores publishConfig.exports — pack ' +
        'with pnpm), a workspace package copied with its workspace manifest, or the @marmeon/source condition outside the ' +
        "framework's monorepo (NODE_OPTIONS).",
      docs: 'docs/package-development.md#building-and-publishing',
    }),
  },
  {
    for: ConfigError,
    code: 'K6',
    // The variables the start found missing or invalid (listed with •) — not a ConfigError that says something else, and not
    // one that lists only renamed variables: its message names the new variable and the docs, and "set the old name" is the opposite.
    when: (e) => listedIssues(e.message).some((issue) => !issue.renamed),
    solve: (e) => configSolution(e.message),
  },
]);

/** What to do when the injection transform could not derive a list — by its reason. */
function injectionSolution(key: string, reason: string | undefined): Solution {
  const docs = 'docs/container.md#constructor-injection';
  if (reason?.includes('"import type"')) {
    return { title: 'Import the token as a value', text: `${reason} A type-only import is erased before the code runs, so there is nothing to inject.`, docs };
  }
  if (reason?.includes('is only a type')) {
    return { title: 'Declare a token for the interface', text: reason, docs };
  }
  if (reason?.includes('only classes and tokens can be injected') || reason?.includes('add a type annotation')) {
    return { title: 'Inject a class or a token', text: `${reason} Primitives (a number, a string) come from configuration: inject the config object.`, docs };
  }
  if (reason) return { title: 'Fix the constructor parameter', text: reason, docs };
  return {
    title: `Give ${key} an injection list`,
    text:
      `${key} takes constructor arguments but has no generated list. App code gets it from the loader (marmeon dev/start, ` +
      'Vitest through the marmeon() plugin); a package from "marmeon package:build". Code loaded another way needs `static inject = [...]`.',
    command: 'marmeon package:build',
    docs,
  };
}

/** One `  • name: PATH — message` line of a configuration error (`validateConfig`); `renamed` for a retired name (`EnvSchema.renamed()`). */
function listedIssues(message: string): { variable: string | undefined; renamed: boolean }[] {
  return message
    .split('\n')
    .filter((line) => /^\s*•\s/.test(line))
    .map((line) => {
      // The whole path, `SMTP.HOST` of a nested schema too; an issue without one names none. A retired name's message starts with its own path.
      const match = /^\s*•\s*[\w.-]+:\s*([^\s—]+) — (?:(\1) was renamed \S+ — )?/.exec(line);
      return { variable: match?.[1], renamed: match?.[2] !== undefined };
    });
}

/** What to do about invalid configuration: set the variables its message lists (packages add more specific solutions). */
function configSolution(message: string): Solution {
  const issues = listedIssues(message);
  const variables = [...new Set(issues.filter((issue) => !issue.renamed).flatMap((issue) => issue.variable ?? []))];
  const names = variables.length > 0 ? variables.join(', ') : 'the variables listed';
  const renamed = issues.some((issue) => issue.renamed) ? ' Do not set the renamed variables above under their old name: their lines say the new name and how the value carries over.' : '';
  return {
    title: `Set ${names} in .env`,
    text:
      `The configuration is checked when the app starts: ${names} ${variables.length === 1 ? 'is' : 'are'} missing or invalid. ` +
      'Set them in .env (copy the lines from .env.example) or in the environment; .env.{NODE_ENV} (.env.test) is read on top.' +
      renamed,
    docs: 'docs/configuration.md#when-a-value-is-wrong',
  };
}

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { CommandInput } from '../command.ts';
import { style } from '../output.ts';

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Shared checks and file writing for the `make:*` generators. */
function write(input: CommandInput, file: string, contents: string): boolean {
  if (existsSync(file) && input.options.force !== true) {
    input.output.error(`${relative(input.root, file)} already exists (use --force to overwrite).`);
    return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  input.output.success(`Created ${relative(input.root, file)}`);
  return true;
}

function moduleDir(input: CommandInput): string | undefined {
  const module = input.options.module;
  if (typeof module !== 'string' || !KEBAB.test(module)) {
    input.output.error('Pass the module: --module=<kebab-case-name>');
    return undefined;
  }
  const dir = join(input.root, 'modules', module);
  if (!existsSync(dir)) {
    input.output.error(`Module "${module}" does not exist. Create it first: bespoke make:module ${module}`);
    return undefined;
  }
  return dir;
}

function className(input: CommandInput, suffix = ''): string | undefined {
  const [name] = input.args;
  if (!name || !PASCAL.test(name)) {
    input.output.error(`Pass a PascalCase name, e.g. ${suffix ? `Show${suffix}` : 'OrderShipped'}.`);
    return undefined;
  }
  return suffix && !name.endsWith(suffix) ? `${name}${suffix}` : name;
}

const moduleOption = { module: { type: 'string', short: 'm' }, force: { type: 'boolean' } } as const;

export class MakeModuleCommand {
  static command = 'make:module';
  static description = 'Create a feature module';
  static usage = '<name>';
  static options = { force: { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const [name] = input.args;
    if (!name || !KEBAB.test(name)) {
      input.output.error('Pass a kebab-case name, e.g. bespoke make:module billing');
      return 1;
    }
    const dir = join(input.root, 'modules', name);
    const variable = name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    const ok =
      write(input, join(dir, 'index.ts'), MODULE(name)) && write(input, join(dir, 'routes.ts'), ROUTES);
    if (!ok) return 1;

    input.output.line();
    input.output.line(`Register it in bootstrap/app.ts:`);
    input.output.line(style('dim', `  import ${variable} from '#modules/${name}';`));
    input.output.line(style('dim', `  modules: [..., ${variable}]`));
    return 0;
  }
}

export class MakeControllerCommand {
  static command = 'make:controller';
  static description = 'Create an invokable controller (one endpoint)';
  static usage = '<Name> --module=<module> [--view]';
  static options = { ...moduleOption, view: { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Controller');
    if (!dir || !name) return 1;

    const module = input.options.module as string;
    const page = name.replace(/Controller$/, '');
    const withView = input.options.view === true;
    if (!write(input, join(dir, 'controllers', `${name}.ts`), CONTROLLER(name, withView ? `${module}/${page}` : undefined))) return 1;
    if (withView && !write(input, join(dir, 'views', `${page}.tsx`), VIEW(name, page))) return 1;

    input.output.line();
    input.output.line(`Add a route in modules/${module}/routes.ts:`);
    input.output.line(style('dim', `  Route.get('/…', ${name}).name('${module}.…');`));
    return 0;
  }
}

export class MakeEventCommand {
  static command = 'make:event';
  static description = 'Create an event class';
  static usage = '<Name> --module=<module>';
  static options = moduleOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input);
    if (!dir || !name) return 1;
    return write(input, join(dir, 'events', `${name}.ts`), EVENT(name)) ? 0 : 1;
  }
}

export class MakeListenerCommand {
  static command = 'make:listener';
  static description = 'Create an event listener';
  static usage = '<Name> --event=<Event> --module=<module>';
  static options = { ...moduleOption, event: { type: 'string', short: 'e' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input);
    const event = input.options.event;
    if (!dir || !name) return 1;
    if (typeof event !== 'string' || !PASCAL.test(event)) {
      input.output.error('Pass the event: --event=<EventName>');
      return 1;
    }
    if (!write(input, join(dir, 'listeners', `${name}.ts`), LISTENER(name, event))) return 1;

    input.output.line();
    input.output.line(`Register it in modules/${input.options.module}/index.ts:`);
    input.output.line(style('dim', `  listeners: [listen(${event}, ${name})]`));
    return 0;
  }
}

export class MakeMiddlewareCommand {
  static command = 'make:middleware';
  static description = 'Create a middleware class';
  static usage = '<Name> --module=<module>';
  static options = moduleOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input);
    if (!dir || !name) return 1;
    return write(input, join(dir, 'middleware', `${name}.ts`), MIDDLEWARE(name)) ? 0 : 1;
  }
}

// --- Templates ---------------------------------------------------------------

const MODULE = (name: string) => `import { defineModule } from '@bespokecore/core';
import routes from './routes.ts';

export default defineModule({
  name: '${name}',
  routes,
});
`;

const ROUTES = `import { defineRoutes } from '@bespokecore/http';

export default defineRoutes((Route) => {
  // Route.get('/path', ShowSomethingController).name('module.something');
});
`;

const CONTROLLER = (name: string, page: string | undefined) => `import { Controller, type HttpContext } from '@bespokecore/http';

/** One endpoint. Dependencies go into the constructor — they are injected automatically. */
export class ${name} extends Controller {
  handle(ctx: HttpContext) {
${page ? `    return this.view('${page}', {});` : `    return this.json({ path: new URL(ctx.request.url).pathname });`}
  }
}
`;

const VIEW = (controller: string, page: string) => `import type { PageProps } from '@bespokecore/http';
import type { ${controller} } from '../controllers/${controller}.ts';

type Props = PageProps<${controller}>;

export default function ${page}(props: Props) {
  return <main>{JSON.stringify(props)}</main>;
}
`;

const EVENT = (name: string) => `export class ${name} {
  // Makes the class nominal: TypeScript would otherwise treat events of the same shape as one type.
  readonly #event = true;

  constructor() {}
}
`;

const LISTENER = (name: string, event: string) => `import type { ${event} } from '../events/${event}.ts';

/** Dependencies go into the constructor — they are injected automatically. */
export class ${name} {
  handle(event: ${event}): void {
    void event;
  }
}
`;

const MIDDLEWARE = (name: string) => `import type { HttpContext, Next } from '@bespokecore/http';

/** Built per request from the container. What you pass to next() becomes available downstream. */
export class ${name} {
  handle(ctx: HttpContext, next: Next<{}>) {
    return next();
  }
}
`;

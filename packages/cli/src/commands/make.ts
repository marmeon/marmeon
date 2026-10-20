import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { editDefinition, editDefinitionFile, importedBindings, type DefinitionEdit } from '@marmeon/core';
import { bindingNameOf } from '@marmeon/core/internal';
import { CommandRegistry, type CommandInput } from '../command.ts';
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
    input.output.error(`Module "${module}" does not exist. Create it first: marmeon make:module ${module}`);
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

const registeringOption = { ...moduleOption, 'no-register': { type: 'boolean' } } as const;

/** What `registerInModule` says; a missing `added` or `present` line prints nothing for that outcome. */
interface RegisterMessages {
  readonly added?: string;
  readonly present?: string;
  /** The line above the dim lines when nothing is edited (`--no-register`). */
  readonly heading: string;
  /** The lines to add by hand. */
  readonly manual: readonly string[];
  /** A reason the generator already knows the edit cannot be made — printed like a `manual` outcome, nothing is edited. */
  readonly unregistrable?: string;
  /** Edit this file instead of the module's index.ts, shown as `shown` (an app-relative path). A missing file prints the lines as `--no-register` does. */
  readonly target?: { readonly file: string; readonly shown: string };
}

const indexOf = (module: string) => `modules/${module}/index.ts`;

/** Adds what a generator wrote to its module's index.ts (or to `messages.target`, such as bootstrap/app.ts) — or prints the lines to add (see docs/console.md#generators). */
function registerInModule(
  input: CommandInput,
  module: string,
  dir: string,
  edit: DefinitionEdit,
  messages: RegisterMessages,
): 'added' | 'present' | 'manual' | 'printed' {
  const shown = messages.target?.shown ?? indexOf(module);
  const printLines = () => {
    for (const line of messages.manual) input.output.line(style('dim', `  ${line}`));
  };
  const notRegistered = (reason: string) => {
    input.output.line();
    input.output.warn(`Not registered — ${shown}: ${reason}. Add it yourself:`);
    printLines();
  };
  const file = messages.target?.file ?? join(dir, 'index.ts');
  if (input.options['no-register'] === true || (messages.target !== undefined && !existsSync(file))) {
    input.output.line();
    input.output.line(messages.heading);
    printLines();
    return 'printed';
  }
  if (messages.unregistrable !== undefined) {
    notRegistered(messages.unregistrable);
    return 'manual';
  }
  const outcome = editDefinitionFile(file, edit, shown);
  if (outcome.status === 'added') {
    if (messages.added !== undefined) {
      input.output.line();
      input.output.success(messages.added);
    }
  } else if (outcome.status === 'present') {
    if (messages.present !== undefined) {
      input.output.line();
      input.output.line(messages.present);
    }
  } else notRegistered(outcome.reason);
  return outcome.status === 'manual' ? 'manual' : outcome.status;
}

export class MakeModuleCommand {
  static command = 'make:module';
  static description = 'Create a feature module';
  static usage = '<name> [--no-register]';
  static options = { force: { type: 'boolean' }, 'no-register': { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const [name] = input.args;
    if (!name || !KEBAB.test(name)) {
      input.output.error('Pass a kebab-case name, e.g. marmeon make:module billing');
      return 1;
    }
    const dir = join(input.root, 'modules', name);
    const variable = bindingNameOf(name);
    const ok =
      write(input, join(dir, 'index.ts'), MODULE(name)) && write(input, join(dir, 'routes.ts'), ROUTES);
    if (!ok) return 1;

    registerInModule(
      input,
      name,
      dir,
      {
        define: { name: 'defineApplication', from: '@marmeon/core' },
        key: 'modules',
        add: { element: (names) => names[variable]!, position: 'last' },
        imports: [{ name: variable, from: `#modules/${name}`, kind: 'default' }],
      },
      {
        added: 'Registered the module in bootstrap/app.ts',
        present: `${name} is already registered in bootstrap/app.ts`,
        heading: 'Register it in bootstrap/app.ts:',
        manual: [`import ${variable} from '#modules/${name}';`, `modules: [..., ${variable}]`],
        target: { file: join(input.root, 'bootstrap', 'app.ts'), shown: 'bootstrap/app.ts' },
      },
    );
    return 0;
  }
}

export class MakeControllerCommand {
  static command = 'make:controller';
  static description = 'Create an invokable controller (one endpoint)';
  static usage = '<Name> --module=<module> [--view] [--request]';
  static options = { ...moduleOption, view: { type: 'boolean' }, request: { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Controller');
    if (!dir || !name) return 1;

    const module = input.options.module as string;
    const page = name.replace(/Controller$/, '');
    const withView = input.options.view === true;
    // A GET has no body: a reading endpoint (Show…, List…) gets a `query` schema, any other a body `schema`.
    const reads = READING.test(name);
    // A writing endpoint answers its form with a redirect: a page beside it would never render.
    if (withView && input.options.request === true && !reads) {
      input.output.error(
        `--view renders a page, and ${name} answers a form with a redirect (--request on a name that does not read). Name a reading endpoint (Show…, List…, Index…, Search…, Get…, Find…, Browse…) for a page, or leave out --view.`,
      );
      return 1;
    }
    const template =
      input.options.request === true
        ? reads
          ? QUERY_REQUEST_CONTROLLER(name, page, withView ? `${module}/${page}` : undefined)
          : REQUEST_CONTROLLER(name, page)
        : CONTROLLER(name, withView ? `${module}/${page}` : undefined);
    if (!write(input, join(dir, 'controllers', `${name}.ts`), template)) return 1;
    if (withView && !write(input, join(dir, 'views', `${page}.tsx`), VIEW(name, page))) return 1;

    input.output.line();
    input.output.line(`Add a route in modules/${module}/routes.ts:`);
    const method = input.options.request === true && !reads ? 'post' : 'get';
    input.output.line(style('dim', `  Route.${method}('/…', ${name}).name('${module}.…');`));
    input.output.line(
      style('dim', 'Say who may call it: `authorize: can(Policy, …)` in its request, or `Route.authorize(…)` on its registrar; `everyone` if anyone may.'),
    );
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
  static description = 'Create an event listener (--queued: run by a worker, with a stable name)';
  static usage = '<Name> --event=<Event> --module=<module> [--queued] [--no-register]';
  static options = { ...registeringOption, event: { type: 'string', short: 'e' }, queued: { type: 'boolean' } } as const;
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
    const module = input.options.module as string;
    const source = eventSource(dir, module, event);
    const listener = input.options.queued ? QUEUED_LISTENER(name, event, source.listenerFrom, source.listenerImport, `${module}.${stableName(name, 'Listener') || 'listener'}`) : LISTENER(name, event, source.listenerFrom, source.listenerImport);
    if (!write(input, join(dir, 'listeners', `${name}.ts`), listener)) return 1;

    registerInModule(
      input,
      module,
      dir,
      {
        define: { name: 'defineModule', from: '@marmeon/core' },
        key: 'listeners',
        add: { element: (names) => `${names.listen}(${names[event]}, ${names[name]})` },
        imports: [
          { name: 'listen', from: '@marmeon/core' },
          { name: event, from: source.indexFrom, reuseAnyBinding: source.followed },
          { name, from: `./listeners/${name}.ts` },
        ],
      },
      {
        added: `Registered ${name} in ${indexOf(module)} (listeners)`,
        present: `${name} is already registered in ${indexOf(module)}`,
        heading: `Register it in ${indexOf(module)}:`,
        manual: [
          `import { listen } from '@marmeon/core';`,
          `import { ${event} } from '${source.indexFrom}';`,
          `import { ${name} } from './listeners/${name}.ts';`,
          `listeners: [listen(${event}, ${name})]`,
        ],
        unregistrable: source.problem,
      },
    );
    return 0;
  }
}

/**
 * Where a listener finds its event: the module's own `events/`, else the value import `index.ts` already
 * has for it (a package's event, another module's). Anything else is not guessed.
 */
function eventSource(
  dir: string,
  module: string,
  event: string,
): { indexFrom: string; listenerFrom: string; listenerImport: string; followed: boolean; problem?: string } {
  const own = `events/${event}.ts`;
  const ownSource = { indexFrom: `./${own}`, listenerFrom: `../${own}`, listenerImport: event, followed: false };
  if (existsSync(join(dir, own))) return ownSource;
  const index = join(dir, 'index.ts');
  const text = existsSync(index) ? readFileSync(index, 'utf8') : undefined;
  const binding = text === undefined ? undefined : importedBindings(text, 'index.ts').get(event);
  if (binding && !binding.typeOnly && binding.imported !== 'default' && binding.imported !== '*') {
    const from = binding.from;
    const listenerFrom = from.startsWith('./') ? `../${from.slice(2)}` : from.startsWith('../') ? `../${from}` : from;
    return { indexFrom: from, listenerFrom, listenerImport: binding.imported === event ? event : `${binding.imported} as ${event}`, followed: true };
  }
  // A file that does not parse has no bindings; the editor names that reason, not a missing event.
  const probe =
    text === undefined
      ? undefined
      : editDefinition(text, 'index.ts', { define: { name: 'defineModule', from: '@marmeon/core' }, key: 'probe', add: { value: '0' } });
  if (probe?.status === 'manual' && probe.reason.includes('parse')) return { ...ownSource, problem: probe.reason };
  return {
    ...ownSource,
    problem: `${event} is neither in modules/${module}/events/ nor imported by ${indexOf(module)} (create it with make:event, or import it there)`,
  };
}

export class MakeJobCommand {
  static command = 'make:job';
  static description = 'Create a queued job (a class with handle(), a stable name and a payload schema)';
  static usage = '<Name> --module=<module> [--no-register]';
  static options = registeringOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Job');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    // The stable name the queue stores — from the class name once; renaming the class later keeps it.
    if (!write(input, join(dir, 'jobs', `${name}.ts`), JOB(name, `${module}.${stableName(name, 'Job') || 'job'}`))) return 1;

    registerInModule(
      input,
      module,
      dir,
      {
        define: { name: 'defineModule', from: '@marmeon/core' },
        key: 'jobs',
        add: { element: (names) => names[name]! },
        imports: [{ name, from: `./jobs/${name}.ts` }],
      },
      {
        added: `Registered ${name} in ${indexOf(module)} (jobs)`,
        present: `${name} is already registered in ${indexOf(module)}`,
        heading: `Register it in ${indexOf(module)}:`,
        manual: [`import { ${name} } from './jobs/${name}.ts';`, `jobs: [${name}]`],
      },
    );
    input.output.line(style('dim', `Dispatch it: await queue.dispatch(${name}, { id: 1 });   (constructor(queue: Queue), from @marmeon/queue)`));
    return 0;
  }
}

/** `SendInvoiceReminderJob` → `send-invoice-reminder`: the kebab-case part of a stable name, without the class suffix. */
function stableName(name: string, suffix: string): string {
  return name
    .replace(new RegExp(`${suffix}$`), '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export class MakeNotificationCommand {
  static command = 'make:notification';
  static description = 'Create a notification (a stable name, the schema of its data, via() and a to…() per channel)';
  static usage = '<Name> --module=<module> [--no-register]';
  static options = registeringOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Notification');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    // The stable name the queue and the notifications table store — from the class name once, like a job's.
    if (!write(input, join(dir, 'notifications', `${name}.ts`), NOTIFICATION(name, `${module}.${stableName(name, 'Notification') || 'notification'}`))) return 1;

    registerInModule(
      input,
      module,
      dir,
      {
        define: { name: 'defineModule', from: '@marmeon/core' },
        key: 'notifications',
        add: { element: (names) => names[name]! },
        imports: [{ name, from: `./notifications/${name}.ts` }],
      },
      {
        added: `Registered ${name} in ${indexOf(module)} (notifications)`,
        present: `${name} is already registered in ${indexOf(module)}`,
        heading: `Register it in ${indexOf(module)}:`,
        manual: [`import { ${name} } from './notifications/${name}.ts';`, `notifications: [${name}]`],
      },
    );
    input.output.line(
      style('dim', `Send it: await notifications.send({ type: 'user', id: user.id }, ${name}, { id: 1 });   (constructor(notifications: Notifications), from @marmeon/notifications)`),
    );
    input.output.line(style('dim', 'The database channel needs its table once: marmeon make:notifications-table && marmeon migrate'));
    return 0;
  }
}

export class MakeCommandCommand {
  static command = 'make:command';
  static description = 'Create a console command (listed by marmeon list)';
  static usage = '<Name> --module=<module> [--no-register]';
  static options = registeringOption;
  // The app as `marmeon build` has it — every provider registered, none booted — so the name is checked against the
  // packages' commands too, and no `.env` is needed.
  static boots = 'build' as const;

  readonly #commands: CommandRegistry;

  constructor(commands: CommandRegistry) {
    this.#commands = commands;
  }

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Command');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    // The name typed on the command line — from the class name once; renaming the class later keeps it.
    const command = `${module}:${stableName(name, 'Command') || 'command'}`;
    const file = join(dir, 'commands', `${name}.ts`);
    // The registry is what the start checks: a file no module lists is not a command yet. The same class in this module
    // is a regeneration (`--force` over the file this writes), not a clash.
    const taken = this.#commands.owner(command);
    const regeneration = existsSync(file) && taken?.source === `module ${module}` && taken.command.name === name;
    if (taken && !regeneration) {
      input.output.error(`${command} is already the name of ${taken.command.name} (${taken.source}): two commands cannot share a name. Rename the class or choose another module.`);
      return 1;
    }
    if (!write(input, file, COMMAND(name, command))) return 1;

    registerInModule(
      input,
      module,
      dir,
      {
        define: { name: 'defineModule', from: '@marmeon/core' },
        key: 'commands',
        add: { element: (names) => names[name]! },
        imports: [{ name, from: `./commands/${name}.ts` }],
      },
      {
        added: `Registered ${name} in ${indexOf(module)} (commands)`,
        present: `${name} is already registered in ${indexOf(module)}`,
        heading: `Register it in ${indexOf(module)}:`,
        manual: [`import { ${name} } from './commands/${name}.ts';`, `commands: [${name}]`],
      },
    );
    return 0;
  }
}

export class MakeSeederCommand {
  static command = 'make:seeder';
  static description = 'Create a seeder (a class with handle(), run by db:seed)';
  static usage = '<Name> --module=<module> [--no-register]';
  static options = registeringOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Seeder');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    if (!write(input, join(dir, 'seeders', `${name}.ts`), SEEDER(name))) return 1;

    const outcome = registerInModule(
      input,
      module,
      dir,
      {
        define: { name: 'defineModule', from: '@marmeon/core' },
        key: 'seeders',
        add: { element: (names) => names[name]! },
        imports: [{ name, from: `./seeders/${name}.ts` }],
      },
      {
        added: `Registered ${name} in ${indexOf(module)} (seeders)`,
        present: `${name} is already registered in ${indexOf(module)}`,
        heading: `Register it in ${indexOf(module)}:`,
        manual: [`import { ${name} } from './seeders/${name}.ts';`, `seeders: [${name}]`],
      },
    );
    // Seeders run in the order of the list, and the generator cannot know where this one belongs.
    if (outcome === 'added') input.output.line(style('dim', `Seeders run in the order of \`seeders\`; ${name} was added last. Move it after the seeders whose rows it needs.`));
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

export class MakePolicyCommand {
  static command = 'make:policy';
  static description = 'Create a policy that allows the owner of a record only';
  static usage = '<Name> --module=<module>';
  static options = moduleOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Policy');
    if (!dir || !name) return 1;
    if (!dependsOn(input.root, '@marmeon/auth')) {
      input.output.error('A policy answers with `deny…` of @marmeon/auth: pnpm add @marmeon/auth');
      return 1;
    }
    if (!write(input, join(dir, 'policies', `${name}.ts`), POLICY(name, 'Owned', OWNED))) return 1;
    input.output.line(style('dim', `Use it in a request: authorize: can(${name}, 'update', '<param>')`));
    input.output.line(style('dim', 'See docs/authorization.md#writing-policies'));
    return 0;
  }
}

/** Whether the app's package.json lists `name` in its dependencies or devDependencies. */
function dependsOn(root: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies'].some((field) => {
      const group = manifest[field];
      return typeof group === 'object' && group !== null && name in group;
    });
  } catch {
    return false;
  }
}

// --- Templates ---------------------------------------------------------------

/** Whether a module's source sets `migrations` (the test `marmeon publish:migration` uses too). */
const MIGRATIONS_PROPERTY = /migrations\s*:/;

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Creates a migration in a module. The name decides the template: `create_users_table` creates the
 * table, `add_bio_to_users_table` (…_to_/_from_/_in_…_table) changes it, anything else is blank.
 */
export class MakeMigrationCommand {
  static command = 'make:migration';
  static description = 'Create a migration in a module';
  static usage = '<snake_case_name> --module=<module> [--no-register]';
  static options = registeringOption;
  static boots = false;

  handle(input: CommandInput): number {
    const [name] = input.args;
    if (!name || !SNAKE.test(name)) {
      input.output.error('Pass a snake_case name, e.g. marmeon make:migration create_invoices_table --module=billing');
      return 1;
    }
    const dir = moduleDir(input);
    if (!dir) return 1;
    const stamp = migrationStamp(join(dir, 'migrations'));
    const create = /^create_(\w+?)_table$/.exec(name)?.[1];
    const alter = /_(?:to|from|in)_(\w+?)_table$/.exec(name)?.[1];
    const contents = create ? CREATE_MIGRATION(create) : alter ? ALTER_MIGRATION(alter) : BLANK_MIGRATION;
    if (!write(input, join(dir, 'migrations', `${stamp}_${name}.ts`), contents)) return 1;

    const module = input.options.module as string;
    const index = join(dir, 'index.ts');
    // A module that already says `migrations:` (also in a definition built elsewhere, which the editor cannot read) needs neither
    // an edit nor the hint.
    if (existsSync(index) && MIGRATIONS_PROPERTY.test(readFileSync(index, 'utf8'))) return 0;
    registerInModule(
      input,
      module,
      dir,
      { define: { name: 'defineModule', from: '@marmeon/core' }, key: 'migrations', add: { value: "new URL('./migrations/', import.meta.url)" } },
      {
        added: `Registered the migrations folder in ${indexOf(module)}`,
        heading: 'Register the directory in the module (once):',
        manual: ["defineModule({ …, migrations: new URL('./migrations/', import.meta.url) })"],
      },
    );
    return 0;
  }
}

const MODULE = (name: string) => `import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: '${name}',
  routes,
});
`;

const ROUTES = `import { defineRoutes } from '@marmeon/http';

export default defineRoutes((Route) => {
  // Route.get('/path', ShowSomethingController).name('module.something');
});
`;

const CONTROLLER = (name: string, page: string | undefined) => `import { Controller, type HttpContext } from '@marmeon/http';

/** One endpoint. Dependencies go into the constructor — they are injected automatically. */
export class ${name} extends Controller {
  handle(ctx: HttpContext) {
${page ? `    return this.view('${page}', {});` : `    return this.json({ path: new URL(ctx.request.url).pathname });`}
  }
}
`;

/** Controllers that read (GET routes) — their request validates the query, never a body. */
const READING = /^(Show|List|Index|Search|Get|Find|Browse)[A-Z]/;

/** REPR for a GET: the query schema (every field optional or with a default — an invalid one falls back to it). */
const QUERY_REQUEST_CONTROLLER = (name: string, subject: string, page: string | undefined) => `import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ${subject}Request = defineRequest({
  // The URL's query, parsed: \`ctx.query\` is typed, and so are \`<Link query>\` and \`useQueryState\`. The URL has strings —
  // r.integer() takes their spelling; every field needs a default (an invalid one falls back to it) or must be optional.
  query: r.query({
    q: r.string().trim().max(100).default(''),
    page: r.integer().min(1).default(1),
  }),
});

/** One endpoint. The query is parsed before \`handle\` runs; dependencies are injected into the constructor. */
export class ${name} extends Controller {
  static request = ${subject}Request;

  handle(ctx: ContextOf<typeof ${subject}Request>) {
${page ? `    return this.view('${page}', { q: ctx.query.q, page: ctx.query.page });` : `    return this.json({ q: ctx.query.q, page: ctx.query.page });`}
  }
}
`;

/** REPR: the request (schema), the endpoint and its answer in one file. */
const REQUEST_CONTROLLER = (name: string, subject: string) => `import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ${subject}Request = defineRequest({
  // The rules of @marmeon/validation, typed — messages in the request's language.
  schema: r.object({
    name: r.string().trim().required().max(255),
  }),
});

/** One endpoint. The body is validated before \`handle\` runs; dependencies are injected into the constructor. */
export class ${name} extends Controller {
  static request = ${subject}Request;

  handle(ctx: ContextOf<typeof ${subject}Request>) {
    // A flash message: shown once by the page the user sees next — \`useFlash('toast', …)\` in the layout.
    return this.back().flash('toast', { kind: 'success', message: \`Saved \${ctx.body.name}.\` });
  }
}
`;

const VIEW = (controller: string, page: string) => `import type { PageProps } from '@marmeon/http';
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

const LISTENER = (name: string, event: string, from: string, imported = event) => `import type { ${imported} } from '${from}';

/** Dependencies go into the constructor — they are injected automatically. */
export class ${name} {
  handle(event: ${event}): void {
    void event;
  }
}
`;

const QUEUED_LISTENER = (name: string, event: string, from: string, imported: string, listener: string) => `import type { EventPayload } from '@marmeon/core';
import type { ${imported} } from '${from}';

/**
 * Queued: a worker runs it with the event's payload (its \`static schema\` — the event needs \`static event\` and
 * \`static schema\`). Dependencies go into the constructor — they are injected automatically.
 */
export class ${name} {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = '${listener}';
  static readonly queue = {}; // { queue: 'mail', tries: 3, backoff: [10, 60] }

  handle(payload: EventPayload<typeof ${event}>): void {
    void payload;
  }
}
`;

const JOB = (name: string, job: string) => `import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';

/**
 * A queued job: dependencies go into the constructor (injected per attempt), the data into the payload — JSON, checked
 * against the schema when dispatched and before it runs. Pass IDs, not records. A job can run more than once (a worker
 * may stop after the work, before the acknowledgement): make it safe to repeat.
 */
export class ${name} {
  /** Stable — the queue stores this name, never the class name. */
  static readonly job = '${job}';
  static readonly schema = r.object({ id: r.integer() });
  // static readonly tries = 3;            // attempts in all (default 1)
  // static readonly backoff = [10, 60];   // seconds before each retry
  // static readonly timeout = 60;         // seconds; then job.signal aborts

  async handle(payload: JobPayload<typeof ${name}>, job: JobContext): Promise<void> {
    void payload;
    void job; // job.signal aborts at the timeout — pass it on: fetch(url, { signal: job.signal })
  }
}
`;

const NOTIFICATION = (name: string, notification: string) => `import type { DatabaseInput, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';

/**
 * A notification: sent to recipients as data — \`notifications.send({ type: 'user', id }, ${name}, { id })\` —
 * and delivered by a worker through the channels \`via()\` returns, in the recipient's language. Dependencies go into
 * the constructor (injected per delivery), the data into the schema — JSON, checked when sent and before delivery.
 * Pass IDs, not records. \`implements Notification<'user'>\` checks \`via()\` against a kind of recipient where it is written.
 */
export class ${name} {
  /** Stable — the queue and the notifications table store this name, never the class name. */
  static readonly notification = '${notification}';
  static readonly schema = r.object({ id: r.integer() });
  /** What the database channel keeps — the inbox reads it back typed (notificationData(row, ${name})). */
  static readonly database = r.object({ id: r.integer() });
  // static readonly queue = { queue: 'mail' };   // its job (and its mail) on the \`mail\` queue

  via(recipient: unknown) {
    void recipient;
    return ['database'] as const; // and 'mail' with toMail(recipient, data, t) — t in the recipient's language
  }

  toDatabase(data: NotificationData<typeof ${name}>): DatabaseInput<typeof ${name}> {
    return { id: data.id };
  }
}
`;

const COMMAND = (name: string, command: string) => `import type { CommandInput } from 'marmeon';

/** Dependencies go into the constructor — they are injected automatically. */
export class ${name} {
  /** The name typed on the command line; a part before the colon groups it in \`marmeon list\`. */
  static command = '${command}';
  static description = ''; // shown in \`marmeon list\`
  // static usage = '[--force]';
  // static options = { force: { type: 'boolean' } } as const;

  handle({ output }: CommandInput): number {
    output.success('Done.');
    return 0;
  }
}
`;

const SEEDER = (name: string) => `import type { SeedContext } from '@marmeon/database';

/** Dependencies go into the constructor — they are injected automatically. Runs in the order of \`seeders\` in the module. */
export class ${name} {
  async handle({ db, factory }: SeedContext): Promise<void> {
    void db;
    void factory; // await factory(UserFactory).count(10).create()
  }
}
`;

/** The record type of a policy without a table: the structure the policy reads, so the file compiles on its own. */
const OWNED = `// With a table, use its \`Row<'…'>\` instead.
type Owned = { readonly user_id: AuthUser['id'] };
`;

/**
 * Fail-closed: only the owner passes, everyone else gets the answer for a record that does not exist
 * (a 403 would confirm the id exists). `declaration` brings `recordType` into the file, with its import if it needs one.
 */
const POLICY = (name: string, recordType: string, declaration: string) => `import { denyAsNotFound, type AuthUser } from '@marmeon/auth';

${declaration}

/**
 * Only the owner of a record may act on it; everyone else gets a 404, so nobody can probe which ids exist.
 * Use it in a request: \`authorize: can(${name}, 'update', '<param>')\`. See docs/authorization.md#writing-policies.
 */
export class ${name} {
  view(user: AuthUser, record: ${recordType}) {
    return record.user_id === user.id || denyAsNotFound();
  }

  update(user: AuthUser, record: ${recordType}) {
    return record.user_id === user.id || denyAsNotFound();
  }

  delete(user: AuthUser, record: ${recordType}) {
    return record.user_id === user.id || denyAsNotFound();
  }
}
`;

const MIDDLEWARE = (name: string) => `import type { HttpContext, Next } from '@marmeon/http';

/** Built per request from the container. What you pass to next() becomes available downstream. */
export class ${name} {
  handle(ctx: HttpContext, next: Next<{}>) {
    return next();
  }
}
`;

/**
 * `YYYY_MM_DD_HHMMSS` now — but always after the module's latest migration: two generated in the
 * same second would otherwise sort by name, and `add_…_to_invoices` could run before `create_invoices`.
 */
function migrationStamp(directory: string): string {
  const format = (date: Date) => date.toISOString().replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d).*$/, '$1_$2_$3_$4$5$6');
  const latest = existsSync(directory)
    ? readdirSync(directory)
        .map((file) => /^(\d{4})_(\d\d)_(\d\d)_(\d\d)(\d\d)(\d\d)_/.exec(file))
        .filter((match) => match !== null)
        .map(([, y, mo, d, h, mi, se]) => Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)))
        .reduce((max, time) => Math.max(max, time), 0)
    : 0;
  return format(new Date(Math.max(Date.now(), latest + 1000)));
}

const CREATE_MIGRATION = (table: string) => `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.create('${table}', (table) => {
      table.id();
      table.timestamps();
    }),
  down: (schema) => schema.drop('${table}'),
});
`;

const ALTER_MIGRATION = (table: string) => `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) =>
    schema.alter('${table}', (table) => {
      // table.string('nickname').nullable();
    }),
  down: (schema) =>
    schema.alter('${table}', (table) => {
      // table.dropColumn('nickname');
    }),
});
`;

const BLANK_MIGRATION = `import { defineMigration } from '@marmeon/database';

export default defineMigration({
  up: (schema) => {
    // schema.create(…) / schema.alter(…) for tables, schema.data(async (db) => …) for data
  },
  down: (schema) => {},
});
`;

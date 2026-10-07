import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export class MakeModuleCommand {
  static command = 'make:module';
  static description = 'Create a feature module';
  static usage = '<name>';
  static options = { force: { type: 'boolean' } } as const;
  static boots = false;

  handle(input: CommandInput): number {
    const [name] = input.args;
    if (!name || !KEBAB.test(name)) {
      input.output.error('Pass a kebab-case name, e.g. marmeon make:module billing');
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
    // A GET has no body (E65): a reading endpoint (Show…, List…) gets a `query` schema, any other a body `schema`.
    const reads = READING.test(name);
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

export class MakeJobCommand {
  static command = 'make:job';
  static description = 'Create a queued job (a class with handle(), a stable name and a payload schema)';
  static usage = '<Name> --module=<module>';
  static options = moduleOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Job');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    // The stable name the queue stores (E84) — from the class name once; renaming the class later keeps it.
    if (!write(input, join(dir, 'jobs', `${name}.ts`), JOB(name, `${module}.${stableName(name, 'Job') || 'job'}`))) return 1;

    input.output.line();
    input.output.line(`Register it in modules/${module}/index.ts:`);
    input.output.line(style('dim', `  jobs: [${name}]`));
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
  static usage = '<Name> --module=<module>';
  static options = moduleOption;
  static boots = false;

  handle(input: CommandInput): number {
    const dir = moduleDir(input);
    const name = className(input, 'Notification');
    if (!dir || !name) return 1;
    const module = input.options.module as string;
    // The stable name the queue and the notifications table store (E92) — from the class name once, like a job's.
    if (!write(input, join(dir, 'notifications', `${name}.ts`), NOTIFICATION(name, `${module}.${stableName(name, 'Notification') || 'notification'}`))) return 1;

    input.output.line();
    input.output.line(`Register it in modules/${module}/index.ts:`);
    input.output.line(style('dim', `  notifications: [${name}]`));
    input.output.line(
      style('dim', `Send it: await notifications.send({ type: 'user', id: user.id }, ${name}, { id: 1 });   (constructor(notifications: Notifications), from @marmeon/notifications)`),
    );
    input.output.line(style('dim', 'The database channel needs its table once: marmeon make:notifications-table && marmeon migrate'));
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

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Laravel's `make:migration`. The name decides the template: `create_users_table` creates the
 * table, `add_bio_to_users_table` (…_to_/_from_/_in_…_table) changes it, anything else is blank.
 */
export class MakeMigrationCommand {
  static command = 'make:migration';
  static description = 'Create a migration in a module';
  static usage = '<snake_case_name> --module=<module>';
  static options = moduleOption;
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

    if (!readFileSync(join(dir, 'index.ts'), 'utf8').includes('migrations')) {
      input.output.line();
      input.output.line('Register the directory in the module (once):');
      input.output.line(style('dim', "  defineModule({ …, migrations: new URL('./migrations/', import.meta.url) })"));
    }
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

/** Controllers that read (GET routes) — their request validates the query, never a body (E65). */
const READING = /^(Show|List|Index|Search|Get|Find|Browse)[A-Z]/;

/** REPR for a GET: the query schema (every field optional or with a default — an invalid one falls back to it, E56). */
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

/** REPR: the request (schema + authorize), the endpoint and its answer in one file. */
const REQUEST_CONTROLLER = (name: string, subject: string) => `import { Controller, defineRequest, type ContextOf, type HttpContext } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ${subject}Request = defineRequest({
  // Laravel's rules, typed (@marmeon/validation) — messages in the request's language.
  schema: r.object({
    name: r.string().trim().required().max(255),
  }),
  // Runs before validation; returning false answers 403. Its context type is what the route must provide.
  authorize: (_ctx: HttpContext) => true,
});

/** One endpoint. The body is validated before \`handle\` runs; dependencies are injected into the constructor. */
export class ${name} extends Controller {
  static request = ${subject}Request;

  handle(ctx: ContextOf<typeof ${subject}Request>) {
    // A flash message (E60): shown once by the page the user sees next — \`useFlash('toast', …)\` in the layout.
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

const LISTENER = (name: string, event: string) => `import type { ${event} } from '../events/${event}.ts';

/** Dependencies go into the constructor — they are injected automatically. */
export class ${name} {
  handle(event: ${event}): void {
    void event;
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
 * A notification (E92): sent to recipients as data — \`notifications.send({ type: 'user', id }, ${name}, { id })\` —
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
  up: async (schema) => {
    // await schema.create(…) / schema.alter(…) / schema.db for data
  },
  down: async (schema) => {},
});
`;

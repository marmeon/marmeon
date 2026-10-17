import { resolve } from 'node:path';
import { Application, ErrorSolutions, errorCodeOf, HealthChecks, Redactor, type ServiceProviderClass } from '@marmeon/core';
import { coreSolutions, loadDiscoveredPackages } from '@marmeon/core/internal';
import { loadApplication } from '../load.ts';
import { CheckRegistry, type AppCheckClass } from './registry.ts';
import { reportOf, unrunReport, type CheckProblem, type CheckReport } from './report.ts';

/** How long one check of a package may take before it counts as one that could not run (ms). Readiness checks have their own limits. */
export const CHECK_TIMEOUT = 60_000;

/** How long a check that ran out of time gets to clean up after its `signal` aborted (ms). */
const ABORT_GRACE = 5_000;

const CODE_PREFIX = /^\[marmeon:[A-Z]\d+\] /;

/** The registry of an app that loaded; empty when it has none (the CLI provider is not installed). */
export function checkRegistryOf(app: Application): CheckRegistry {
  return app.container.has(CheckRegistry) ? app.container.make(CheckRegistry) : new CheckRegistry();
}

/**
 * The checks the installed packages bring (`static checks` of their providers), for an app that did not load — the names are
 * known without it, so their reports can say they were left out. Never fails; checks only the app itself adds are not among them.
 */
export async function discoveredChecks(root: string): Promise<{ build: string[]; run: string[] }> {
  try {
    const providers = ((await loadDiscoveredPackages({ root })).providers ?? []) as ServiceProviderClass[];
    const registry = new CheckRegistry();
    for (const Provider of providers) registry.add(Provider.checks ?? [], Provider.name || 'a provider');
    return { build: registry.all('build').map((check) => check.check), run: registry.all('run').map((check) => check.check) };
  } catch {
    return { build: [], run: [] };
  }
}

/** The app's redactor — the core's keys alone for an app that did not load. */
function redactorOf(app: Application | undefined): Redactor {
  return app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();
}

/** {@link redactorOf} that cannot fail: the core's keys alone when the app's redactor cannot be built. */
function safeRedactor(app: Application | undefined): Redactor {
  try {
    return redactorOf(app);
  } catch {
    return new Redactor();
  }
}

/** The message of one error, or what stands for it: an `AggregateError` (`ECONNREFUSED` on `localhost`) has none of its own. */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error === 'string' ? error : 'a value that is no Error';
  const { message } = error as { message: unknown };
  if (typeof message === 'string' && message !== '') return message.replace(CODE_PREFIX, '');
  const { code, errors } = error as { code?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) {
    const inner = errors.slice(0, 3).map((one) => (one instanceof Error && typeof one.message === 'string' ? one.message : 'a value that is no Error'));
    return `${typeof code === 'string' ? `${code}: ` : ''}${inner.join('; ')}`;
  }
  return typeof message === 'string' ? (typeof code === 'string' ? code : '(no message)') : '(no message)';
}

/**
 * What an error says, for a report: the messages of the error and its causes (five deep) with the app's path cut off and secrets
 * masked by `redactor` — never a stack, and never the error's own fields. Whatever was thrown, this does not throw.
 */
export function describeFailure(error: unknown, redactor: Redactor, root: string): string {
  try {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth++) {
      parts.push(`${depth > 0 ? 'Caused by: ' : ''}${messageOf(current)}`);
      current = current instanceof Error ? current.cause : undefined;
      if (!(current instanceof Error)) break;
    }
    return redactor.text(parts.join('\n').split(resolve(root)).join('.'));
  } catch {
    return 'the failure could not be described';
  }
}

/** The first solution for an error the app could not start with (`APP_KEY` → `marmeon key:generate`): its command, its docs and its text. Never fails. */
async function solutionFor(error: unknown, root: string): Promise<{ fix?: string; docs?: string; text?: string } | undefined> {
  try {
    const discovered = await loadDiscoveredPackages({ root }).catch(() => undefined);
    const providers = (discovered?.providers ?? []) as ServiceProviderClass[];
    const [solution] = await new ErrorSolutions([...providers.flatMap((Provider) => Provider.solutions ?? []), ...coreSolutions]).find(error);
    return solution && { fix: solution.command, docs: solution.docs, text: solution.text };
  } catch {
    return undefined;
  }
}

/** The finding for an app that did not start: the redacted message, its code, and what the solutions of the core and the packages say to do. */
async function bootProblem(error: unknown, root: string): Promise<CheckProblem> {
  const solution = await solutionFor(error, root);
  const redactor = new Redactor();
  const code = errorCodeOf(error);
  const message = describeFailure(error, redactor, root);
  return {
    severity: 'error',
    message: solution?.fix === undefined && solution?.text ? `${message}\n${redactor.text(solution.text)}` : message,
    ...(code === undefined ? {} : { code }),
    ...(solution?.fix === undefined ? {} : { fix: solution.fix }),
    ...(solution?.docs === undefined ? {} : { docs: solution.docs }),
  };
}

/** A finding a package returned, cut to the fields of a finding: anything else is dropped, and the message is masked. */
function sanitize(problem: unknown, redactor: Redactor, source: string): CheckProblem {
  const found = problem as Partial<CheckProblem> | null;
  if (typeof found !== 'object' || found === null || typeof found.message !== 'string' || (found.severity !== 'error' && found.severity !== 'warning')) {
    return { severity: 'error', message: `${source} returned a finding that is no CheckProblem (it needs a severity of 'error' or 'warning' and a message)` };
  }
  const text = (value: unknown) => (typeof value === 'string' ? { value: redactor.text(value) } : undefined);
  const number = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);
  const file = text(found.file);
  const rule = text(found.rule);
  const fix = text(found.fix);
  const docs = text(found.docs);
  const line = number(found.line);
  const column = number(found.column);
  return {
    severity: found.severity,
    message: redactor.text(found.message),
    ...(file ? { file: file.value } : {}),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(typeof found.code === 'string' && /^[CRKHDAQS]\d+$/.test(found.code) ? { code: found.code } : {}),
    ...(rule ? { rule: rule.value } : {}),
    ...(fix ? { fix: fix.value } : {}),
    ...(docs ? { docs: docs.value } : {}),
  };
}

/** Runs one check of a package in a scope of its own; whatever it throws, or when it takes too long, is that check being `error` — never another's result. */
async function runCheck(Check: AppCheckClass, app: Application, root: string): Promise<CheckReport> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const limit = typeof Check.timeout === 'number' && Check.timeout > 0 ? Check.timeout : CHECK_TIMEOUT;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redactor = redactorOf(app);
    const expired = new Promise<'timeout'>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout('timeout'), limit);
    });
    const work = (async () => app.container.createScope().make(Check).handle({ signal: controller.signal }))();
    // `race` handles both: a check that fails after its time ran out is no unhandled rejection.
    work.catch(() => undefined);
    const outcome = await Promise.race([work, expired]);
    if (outcome === 'timeout') {
      controller.abort();
      // The check may release what it opened before the app shuts down — within bounds.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([work.catch(() => undefined), new Promise((resolveGrace) => (grace = setTimeout(resolveGrace, ABORT_GRACE)).unref())]);
      clearTimeout(grace);
      return unrunReport(Check.check, 'error', `took longer than ${limit} ms`, ms());
    }
    if (!Array.isArray(outcome)) {
      const skipped = (outcome as { skipped?: unknown } | null)?.skipped;
      if (typeof skipped === 'string') return unrunReport(Check.check, 'skipped', redactor.text(skipped), ms());
      return unrunReport(Check.check, 'error', 'handle() must return a list of findings', ms());
    }
    return reportOf(Check.check, outcome.map((problem) => sanitize(problem, redactor, Check.name)), ms());
  } catch (error) {
    return unrunReport(Check.check, 'error', describeFailure(error, safeRedactor(app), root), ms());
  } finally {
    clearTimeout(timer);
  }
}

/** `readiness`: what `/up/ready` runs, once — every check of `static health`, each with its own time limit. */
async function readinessCheck(app: Application, root: string): Promise<CheckReport> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const redactor = redactorOf(app);
    const report = await app.container.make(HealthChecks).run(app.container);
    const problems: CheckProblem[] = [];
    for (const result of report.checks) {
      if (result.status === 'ok') continue;
      const code = result.status === 'failing' ? errorCodeOf(result.error) : undefined;
      problems.push({
        severity: 'error',
        message: result.status === 'timeout' ? `${result.name} took longer than ${result.ms} ms` : `${result.name}: ${describeFailure(result.error, redactor, root)}`,
        ...(code === undefined ? {} : { code }),
        rule: result.name,
      });
    }
    return reportOf('readiness', problems, ms());
  } catch (error) {
    return unrunReport('readiness', 'error', describeFailure(error, safeRedactor(app), root), ms());
  }
}

/** How long a shutdown may take before the report goes out without it (ms). */
const SHUTDOWN_TIMEOUT = 10_000;

/** A shutdown that fails, or hangs, must not take the report of the checks with it. */
async function quietly(shutdown: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, SHUTDOWN_TIMEOUT);
      timer.unref();
    });
    await Promise.race([shutdown, expired]);
  } catch {
    // The checks ran; what they found is the result.
  } finally {
    clearTimeout(timer);
  }
}

/** What `runAppChecks` needs: the app loaded in the build phase (or why it did not), and the names of the checks to run, in report order. */
export interface AppChecksInput {
  readonly root: string;
  readonly build: Application | Error;
  readonly selected: readonly string[];
  /** Filled as the checks finish, so what ran is kept when a later step fails. */
  readonly reports: Map<string, CheckReport>;
  /** Gets what happened outside any check: a rejection or an exception nobody handled. */
  readonly warnings: string[];
}

/**
 * Runs the checks that need the app. Phase one is the app registered and not booted: `build` checks. Then it boots: `boot`, the
 * `run` checks and `readiness`. An app that does not load is `boot: failed` and the checks that needed it are `skipped` (`error` when
 * `boot` itself is not selected, so the run cannot pass without them). Every app is shut down, whatever a check did. A rejection or
 * an exception that nobody handles meanwhile is recorded, masked, on the check that was running, and does not end the process.
 */
export async function runAppChecks({ root, build, selected, reports, warnings }: AppChecksInput): Promise<{ readonly unowned: number }> {
  const started = performance.now();
  const wants = (name: string) => selected.includes(name);
  let current: string | undefined;
  let active: Application | undefined = build instanceof Error ? undefined : build;
  const strays: { readonly name: string | undefined; readonly text: string }[] = [];
  let timedOut = false;
  // After a check ran out of time, a failure cannot be told from the one that check left behind: it has no owner.
  const onStray = (error: unknown) => void strays.push({ name: timedOut ? undefined : current, text: describeFailure(error, safeRedactor(active), root) });
  process.on('unhandledRejection', onStray);
  process.on('uncaughtException', onStray);

  const failedToLoad = async (error: Error) => {
    const reason = describeFailure(error, new Redactor(), root);
    for (const name of selected) {
      if (reports.has(name)) continue;
      if (name === 'boot') reports.set(name, { name, status: 'failed', ms: Math.round(performance.now() - started), problems: [await bootProblem(error, root)] });
      else reports.set(name, unrunReport(name, wants('boot') ? 'skipped' : 'error', wants('boot') ? 'the app did not load' : `the app did not load: ${reason}`, 0));
    }
  };
  const runOne = async (Check: AppCheckClass, app: Application) => {
    current = Check.check;
    const report = await runCheck(Check, app, root);
    if (report.status === 'error' && report.reason?.startsWith('took longer')) timedOut = true;
    reports.set(Check.check, report);
  };

  let run: Application | undefined;
  try {
    if (build instanceof Error) {
      current = 'boot';
      await failedToLoad(build);
    } else {
      const registry = checkRegistryOf(build);
      try {
        for (const Check of registry.all('build')) if (wants(Check.check)) await runOne(Check, build);
      } finally {
        current = undefined;
        await quietly(build.shutdown());
      }
      const needsRun = wants('boot') || wants('readiness') || registry.all('run').some((Check) => wants(Check.check));
      if (needsRun) {
        current = 'boot';
        const loaded = await loadApplication(root, 'run');
        if (loaded instanceof Error) await failedToLoad(loaded);
        else {
          run = active = loaded;
          if (wants('boot')) reports.set('boot', reportOf('boot', [], Math.round(performance.now() - started)));
          for (const Check of registry.all('run')) if (wants(Check.check)) await runOne(Check, loaded);
          if (wants('readiness')) {
            current = 'readiness';
            reports.set('readiness', await readinessCheck(loaded, root));
          }
        }
      }
    }
  } finally {
    current = undefined;
    if (run) await quietly(run.shutdown());
    // A rejection that is still on its way arrives in the next turn of the loop.
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    process.off('unhandledRejection', onStray);
    process.off('uncaughtException', onStray);
  }
  let unowned = 0;
  for (const { name, text } of strays) {
    const report = name === undefined ? undefined : reports.get(name);
    if (!report) {
      unowned++;
      warnings.push(`Unhandled failure that belongs to no check: ${text}`);
    } else if (report.status === 'error' || report.status === 'skipped') reports.set(report.name, { ...report, reason: `${report.reason ?? ''}\nUnhandled failure: ${text}`.trim() });
    else reports.set(report.name, reportOf(report.name, [...report.problems, { severity: 'error', message: `Unhandled failure while it ran: ${text}` }], report.ms));
  }
  return { unowned };
}

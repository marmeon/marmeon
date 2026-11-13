import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, defineConfig, env, Logger, token, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';
import { canonicalTimeZone, packageTexts, PreferredLocale } from '@marmeon/core/internal';
import { editableResponse, HttpError, MiddlewarePriority, Router, translatable, type HttpContext, type Next } from '@marmeon/router';
import { fillPath, PageAlternates, UrlLocales, type PageAlternatesSource } from '@marmeon/router/internal';
import { Session } from '@marmeon/session';
import { Catalog, MessageError } from './catalog.ts';
import frameworkDe from './lang/de.ts';
import frameworkEn from './lang/en.ts';
import { langFileOf } from './loader.ts';
import { isLanguageTag, negotiateLocale, supportedLocale } from './locale.ts';
import { checkOverride, FRAMEWORK, isTree, mergeTexts, overrideFiles, packageOwner, type Tree } from './overrides.ts';
import { createTranslator, CurrentLocale, Translator } from './translator.ts';
import type { CheckTranslationKey, MessageOf, MessageParamsOf, TranslationKey } from './types.ts';

export { Catalog, createMessageLoader, MessageError, MessageSyntaxError } from './messages.ts';
export type { CheckMessageKey, Formatter, LangFiles, MessageAt, MessageKeyOf, MessageLoader, MessageParamsOf, MessagesOf, MessageTree, Namespace, Translate, TranslateArgs, Translations } from './messages.ts';
export { Translator } from './translator.ts';
export type { CheckTranslationKey, MessageOf, TranslationKey } from './types.ts';

declare module '@marmeon/session' {
  interface SessionData {
    /** The locale the visitor chose (a language switcher) — wins over the user's stored one and the browser's. */
    locale: string;
  }
}

const tag = env.string().check(isLanguageTag, 'Expected a language tag like en or de-AT');

export const I18nConfig = defineConfig('i18n', {
  env: env({
    /** The default locale — for visitors whose session, account and browser name none of the supported ones. */
    APP_LOCALE: tag.default('en'),
    /** Where a message missing in a locale comes from (the language of the source files, `lang/en.ts`). */
    APP_FALLBACK_LOCALE: tag.default('en'),
    /**
     * The supported locales, comma-separated (`en,de`). Default: every locale the app has language files for
     * (`modules/<module>/lang/<locale>.ts`, `lang/<locale>.ts`), plus APP_LOCALE and APP_FALLBACK_LOCALE.
     */
    APP_LOCALES: env
      .list(env.string())
      .check((locales) => locales.every((locale) => isLanguageTag(locale)), 'Expected language tags like en,de')
      .default([]),
    /**
     * The IANA time zone dates and times are shown in when a call names none (`Europe/Berlin`), on the server and in the
     * browser alike. Default: the process's zone. Not `SCHEDULE_TIMEZONE`: that one places tasks, this one only displays.
     */
    APP_TIMEZONE: env
      .string()
      .check((value) => canonicalTimeZone(value) !== undefined, (value) => `"${value}" is not an IANA time zone — e.g. Europe/Berlin or UTC`)
      .optional(),
  })
    .check((e) => e.APP_LOCALES.length === 0 || supportedLocale(e.APP_LOCALE, e.APP_LOCALES) !== undefined, 'APP_LOCALE must be one of APP_LOCALES', 'APP_LOCALE')
    .check(
      (e) => e.APP_LOCALES.length === 0 || supportedLocale(e.APP_FALLBACK_LOCALE, e.APP_LOCALES) !== undefined,
      'APP_FALLBACK_LOCALE must be one of APP_LOCALES',
      'APP_FALLBACK_LOCALE',
    ),
  resolve: (e) => {
    const explicit = e.APP_LOCALES.length > 0 ? e.APP_LOCALES : undefined;
    // In the spelling of the list, when there is one.
    const spell = (locale: string) => (explicit ? supportedLocale(locale, explicit)! : locale);
    return { locale: spell(e.APP_LOCALE), fallback: spell(e.APP_FALLBACK_LOCALE), locales: explicit, timeZone: e.APP_TIMEZONE === undefined ? undefined : canonicalTimeZone(e.APP_TIMEZONE) };
  },
});
export type I18nConfig = ConfigOf<typeof I18nConfig>;

/** At boot: a locale the app has language files for (ignored when `APP_LOCALES` names them). */
let addLocale: (locales: Locales, locale: string) => string | undefined;

/**
 * The app's locales: the default (`APP_LOCALE`), the fallback and the supported ones — `APP_LOCALES`, else every locale
 * the app has language files for. The allow-list every value from a request is checked against. Fixed once booted.
 */
export class Locales {
  readonly default: string;
  readonly fallback: string;
  /** Whether `APP_LOCALES` names them (else the language files do). */
  readonly explicit: boolean;
  #supported: readonly string[];

  /** @internal Built by the container. */
  constructor(config: I18nConfig) {
    this.default = config.locale;
    this.fallback = config.fallback;
    this.explicit = config.locales !== undefined;
    this.#supported = Object.freeze([...new Set([config.locale, ...(config.locales ?? [config.fallback])])]);
  }

  /** The default first. */
  get supported(): readonly string[] {
    return this.#supported;
  }

  /** The supported locale `value` names (in its spelling), or undefined — for values from outside. */
  find(value: unknown): string | undefined {
    return supportedLocale(value, this.#supported);
  }

  static {
    // Module-local, and the lists are frozen: no code of an app can widen the allow-list once the app is booted.
    addLocale = (locales, locale) => {
      if (!isLanguageTag(locale)) return undefined;
      if (locales.explicit) return locales.find(locale);
      const known = locales.find(locale);
      if (known) return known;
      locales.#supported = Object.freeze([...locales.#supported, locale]);
      return locale;
    };
  }
}

/**
 * Translators for any locale, outside a request too — a root service a job, a command or a queued listener injects; each
 * translator is fixed to its locale. `for(locale)` takes the supported locale `locale` names, else `APP_LOCALE` — never a
 * locale the app does not have. Whoever a text is for, ask `Translators`: `Translator` is the request's language, and
 * `APP_LOCALE` in a job or a command. See `docs/localization.md#translators-any-language-anywhere`.
 */
export class Translators {
  readonly #catalog: Catalog;
  readonly #locales: Locales;
  readonly #timeZone: string | undefined;
  readonly #cache = new Map<string, Translator>();

  /** @internal Built by the container. */
  constructor(catalog: Catalog, locales: Locales, timeZone?: string) {
    this.#catalog = catalog;
    this.#locales = locales;
    this.#timeZone = timeZone;
  }

  /** A translator fixed to `locale` — or to `APP_LOCALE` when `locale` is none of the supported ones (or missing). */
  for(locale: string | null | undefined): Translator {
    const fixed = this.#locales.find(locale) ?? this.#locales.default;
    let translator = this.#cache.get(fixed);
    if (!translator) {
      translator = createTranslator(this.#catalog, () => fixed, { locales: () => this.#locales.supported, timeZone: this.#timeZone });
      this.#cache.set(fixed, translator);
    }
    return translator;
  }

  /** The translator of `APP_LOCALE`. */
  get default(): Translator {
    return this.for(this.#locales.default);
  }

  /** The supported locales, the default first. */
  get locales(): readonly string[] {
    return this.#locales.supported;
  }
}

/**
 * The signed-in user's stored locale, if the app keeps one — `SetLocale` asks
 * after the session and before the browser. Bound per request; the default knows none. Bind your own in a provider:
 *
 * ```ts
 * container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
 * ```
 */
export interface LocalePreference {
  preferredLocale(): string | null | undefined | Promise<string | null | undefined>;
}
export const LocalePreference = token<LocalePreference>('LocalePreference');

/**
 * What a request's chain chose, by request: the unprefixed address of a localized route (a redirect) asks the visitor's locale
 * from the root, where no scoped service is at hand. Keyed by the request object, so it dies with it.
 */
const preferredOf = new WeakMap<Request, string>();

/**
 * What the tab-sync epoch follows, by request (`PreferredLocale`): the visitor's preferred locale, or `null` for a localized page
 * without a session, which has no epoch. Kept here, not on `CurrentLocale`: it is a contract between framework packages.
 */
const epochLocaleOf = new WeakMap<CurrentLocale, string | null>();

/**
 * Sets the request's locale. On a localized route (`Route.localized()`) it is the one in the URL — nothing else decides, so one
 * URL is one language and a shared cache needs no `Vary: accept-language`. The session is never written (its locale is only ever
 * set by the visitor's own switch) and read only for the preferred locale the tab-sync epoch follows; a localized route
 * in a group without a session reads none, and its page has no epoch. On any other route, the first supported one of: the
 * session's (`locale`, a language switcher), the signed-in user's ({@link LocalePreference}), the browser's
 * (`Accept-Language`), `APP_LOCALE`. In the `web` group, after the session, before CSRF verification (its 419 page is
 * translated too); a group of your own that serves localized routes adds it itself.
 *
 * No value from the request becomes a locale unless it is a supported one ({@link Locales}) — in its spelling: what reaches
 * `<html lang>`, the page's `locale` and the browser's language files is always one of the app's own. With several
 * supported locales the answer of a route that is not localized depends on `Accept-Language`, so it carries
 * `Vary: accept-language`; with one, nothing is negotiated and no `Vary` is sent (every answer is in that locale).
 * See `docs/localization.md#the-locale-in-the-url`.
 */
export class SetLocale {
  readonly #current: CurrentLocale;
  readonly #session: () => Session;
  readonly #preference: LocalePreference;
  readonly #locales: Locales;
  readonly #alternates: (paths: Readonly<Record<string, string>> | undefined, source: PageAlternatesSource) => void;

  /** Built by the container: `SetLocale` is attached to a group as a class, never constructed by an app. @internal */
  constructor(current: CurrentLocale, session: () => Session, preference: LocalePreference, locales: Locales, alternates: (paths: Readonly<Record<string, string>> | undefined, source: PageAlternatesSource) => void) {
    this.#current = current;
    this.#session = session;
    this.#preference = preference;
    this.#locales = locales;
    this.#alternates = alternates;
  }

  /**
   * The locale the visitor prefers: the session's (only a started one), the account's, the browser's, else `APP_LOCALE`. A
   * request without a started session has no choice and no account to ask.
   */
  async #preferred(ctx: HttpContext): Promise<string> {
    const locales = this.#locales;
    // One supported locale: every answer is in it — nothing to choose, and nothing caches must keep apart.
    if (locales.supported.length <= 1) return locales.default;
    const session = this.#session();
    const chosen = session.started
      ? (locales.find(session.get('locale')) ?? locales.find(await this.#preference.preferredLocale()))
      : undefined;
    return chosen ?? negotiateLocale(ctx.request.headers.get('accept-language'), locales.supported) ?? locales.default;
  }

  async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const locales = this.#locales;
    // No route: the 404 of a path that matches none runs the global middleware only.
    const localized = ctx.route?.localized === true;
    // A route that is localized has its locale in the URL (its constraint admits only supported ones — this is the guard).
    const fromUrl = localized ? locales.find((ctx.params as Record<string, unknown>).locale) : undefined;
    if (localized && fromUrl === undefined) throw new HttpError(404);
    let locale: string;
    if (fromUrl !== undefined && !this.#session().started) {
      // Nothing of the visitor decides: the page is one for every cache, and so has no epoch — one that followed the browser's
      // languages would come out of a shared cache with the wrong visitor's.
      epochLocaleOf.set(this.#current, null);
      locale = fromUrl;
    } else {
      const preferred = await this.#preferred(ctx);
      preferredOf.set(ctx.request, preferred);
      // The epoch follows this: moving between `/de/…` and `/en/…` must not reload the visitor's other tabs.
      epochLocaleOf.set(this.#current, preferred);
      locale = fromUrl ?? preferred;
    }
    this.#current.set(locale);
    this.#current.localized = localized;
    // Also when no path can be derived: a controller may still name the versions itself (`PageAlternates.replace()`).
    if (fromUrl !== undefined) this.#alternates(alternatesOf(ctx, locales.supported), { name: ctx.route.routeName ?? ctx.route.path, pattern: ctx.route.path, search: new URL(ctx.request.url).search, locales: locales.supported });

    const response = editableResponse(await next());
    // Read again: `RequestLocale` may have changed it since.
    response.headers.set('content-language', this.#current.value);
    // The URL decides on a localized route, and with one locale nothing is negotiated.
    if (localized || locales.supported.length <= 1) return response;
    // The answer depends on the browser's languages (for visitors without a choice): caches must keep them apart.
    const vary = response.headers.get('vary');
    if (!vary?.toLowerCase().split(',').map((token) => token.trim()).includes('accept-language')) response.headers.set('vary', vary ? `${vary}, accept-language` : 'accept-language');
    return response;
  }
}

/**
 * Sets the request's locale from a record, such as the language of an event the page shows: in a route's `afterAuthorize` hook,
 * `resolve(RequestLocale).use(ctx.params.event.locale)`. `SetLocale` has chosen by then, before the bindings; `use()` replaces
 * its choice for this request — messages, `<html lang>`, `Content-Language`, the page's `locale` and dates follow — and leaves
 * the visitor's own choice (session, account) alone. Call it only once every decision is made — never in a binder or a check; on a
 * route that decides in `handle` (a `Gate`, a table's `authorize`), in the controller after that check, not in `afterAuthorize`.
 * Scoped. See `docs/localization.md#a-page-in-the-language-of-a-record`.
 */
export class RequestLocale {
  readonly #current: CurrentLocale;
  readonly #locales: Locales;

  /** Built by the container; an app resolves it. @internal */
  constructor(current: CurrentLocale, locales: Locales) {
    this.#current = current;
    this.#locales = locales;
  }

  /**
   * Speaks `locale` for the rest of the request when it is a supported one and returns `true`; otherwise returns `false` and
   * changes nothing. Throws on a localized route, where the URL names the locale — which `SetLocale` in the route's chain tells it.
   */
  use(locale: string | null | undefined): boolean {
    if (this.#current.localized) throw new Error('RequestLocale.use(): this route is localized — its URL names the locale.');
    const supported = this.#locales.find(locale);
    if (supported === undefined) return false;
    this.#current.set(supported);
    return true;
  }
}

/**
 * The page of a localized route in every locale: locale to path, the query as it came, plus `x-default` (the path without a
 * locale, which redirects to the visitor's). Built from the route's pattern and the matched parameters — each encoded — never
 * from the request's path. Undefined for a parameter that no path can hold (`..`).
 */
function alternatesOf(ctx: HttpContext, supported: readonly string[]): Record<string, string> | undefined {
  const search = new URL(ctx.request.url).search;
  const name = ctx.route.routeName ?? ctx.route.path;
  const params = ctx.params as Record<string, string>;
  try {
    const alternates: Record<string, string> = {};
    for (const locale of supported) alternates[locale] = fillPath(name, ctx.route.path, { ...params, locale }).path + search;
    alternates['x-default'] = fillPath(name, ctx.route.path.replace(/^\/:locale/, '') || '/', params).path + search;
    return alternates;
  } catch {
    return undefined;
  }
}

/**
 * A validation message by key, for a rule that takes one — in the request's language when validation fails:
 * `r.string().regex(/^[a-z0-9-]+$/, trans('teams.validation.slug'))`. The key is checked like `translator.get()`'s;
 * placeholders come from `params`, the field's name (`{attribute}`) and the rule's parameters (`{min}`, and `{requirement}`
 * when a Valibot schema takes `trans()` as its message function). See `docs/validation.md#messages`.
 */
export function trans<K extends TranslationKey | (string & {})>(
  key: CheckTranslationKey<K>,
  params?: Partial<MessageParamsOf<MessageOf<K>>>,
): (issue: object) => string {
  return translatable(key, params);
}

/**
 * The language files' modules, by URL, once per process. Node keeps a module by its URL anyway; under a module runner (Vitest)
 * every `import()` of a module it already ran is still a round trip to its server — and tests boot an app per test. A failed
 * import is not kept.
 */
const langModules = new Map<string, Promise<unknown>>();
function importLangFile(url: string): Promise<unknown> {
  let module = langModules.get(url);
  if (!module) {
    module = import(url);
    langModules.set(url, module);
    module.catch(() => langModules.delete(url));
  }
  return module;
}

/** Where an app keeps its language files: `lang/<locale>.ts` (namespace `app`) and `modules/<module>/lang/<locale>.ts`. */
async function langFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const list = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
  files.push(...(await list(join(root, 'lang'))));
  const modules = await readdir(join(root, 'modules'), { withFileTypes: true }).catch(() => []);
  for (const module of modules) if (module.isDirectory()) files.push(...(await list(join(root, 'modules', module.name, 'lang'))));
  return files;
}

const frameworkTexts = new Map<string, Tree>([
  ['en', frameworkEn],
  ['de', frameworkDe],
]);

/** Loads the module of a language file, which must export an object of messages. */
async function importTexts(path: string): Promise<Tree> {
  const module = (await importLangFile(pathToFileURL(path).href)) as { default?: unknown };
  if (!isTree(module.default)) throw new MessageError(`${path} must export an object of messages (strings, nested in objects).`);
  return module.default;
}

type PackageText = ReturnType<typeof packageTexts>[number];

/**
 * The installed packages that declare a namespace and language files, in dependency order. An app without a `package.json` has no
 * packages. Read under the server's conditions, and only `lang`: a package may map its client entry for the browser alone.
 */
function packagesWithTexts(root: string): readonly PackageText[] {
  if (!existsSync(join(root, 'package.json'))) return [];
  return packageTexts({ root });
}

/**
 * Loads one package's texts into `catalog` under the package's namespace, with the app's `lang/<namespace>/<locale>.ts` laid over them
 * key by key. An override of a locale the package has is checked against the package's English texts (S6), or, when the package has no English one, its keys against all its files and its placeholders against the file of that locale. An override of a locale the package lacks is the app's own translation: its keys
 * must exist in one of the package's files, its placeholders are the app's.
 */
async function loadPackageTexts(root: string, surface: PackageText, catalog: Catalog, locales: Locales, loaded: string[], skipped: string[]): Promise<void> {
  const owner = packageOwner(surface.package, surface.namespace);
  const overrides = new Map<string, { path: string; tree: Tree }>();
  for (const { path, locale: tag } of await overrideFiles(root, surface.namespace)) {
    const locale = addLocale(locales, tag);
    if (!locale) {
      skipped.push(path);
      continue;
    }
    if (overrides.has(locale)) throw new MessageError(`The ${surface.namespace} messages in ${locale} are reworded twice (${path}).`);
    const tree = await importTexts(path);
    overrides.set(locale, { path, tree });
  }
  const packageLocales = new Set<string>();
  const accepted = new Map<string, string>(); // accepted spelling → tag in the package
  for (const [tag, path] of Object.entries(surface.lang)) {
    const locale = addLocale(locales, tag);
    if (!locale) {
      skipped.push(path);
      continue;
    }
    packageLocales.add(locale);
    accepted.set(locale, tag);
  }
  const allFiles = async (): Promise<Tree> => {
    let union: Tree = {};
    for (const path of Object.values(surface.lang)) union = mergeTexts(union, await importTexts(path));
    return union;
  };
  for (const [locale, tag] of accepted) {
    const path = surface.lang[tag]!;
    const base = await importTexts(path);
    const override = overrides.get(locale);
    if (override === undefined) {
      catalog.add(locale, surface.namespace, base, path);
      loaded.push(path);
      continue;
    }
    if (surface.lang.en === undefined) checkOverride(override.path, root, override.tree, await allFiles(), owner, base);
    else checkOverride(override.path, root, override.tree, await importTexts(surface.lang.en), owner);
    catalog.add(locale, surface.namespace, mergeTexts(base, override.tree), `${path} + ${override.path}`);
    loaded.push(path, override.path);
  }
  let union: Tree | undefined;
  for (const [locale, { path, tree }] of overrides) {
    if (packageLocales.has(locale)) continue;
    union ??= await allFiles();
    checkOverride(path, root, tree, union, owner, false);
    catalog.add(locale, surface.namespace, tree, path);
    loaded.push(path);
  }
}

/**
 * Loads the app's language files into `catalog` — the locales `locales` accepts (all, unless `APP_LOCALES` names
 * them; a file for another locale is skipped). The paths come from the app's folders and the packages' declared
 * `lang` paths, never from a request.
 */
async function loadLangFiles(root: string, catalog: Catalog, locales: Locales): Promise<{ loaded: string[]; skipped: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  const files = (await langFiles(root)).flatMap((path) => {
    const file = langFileOf(path.slice(root.length));
    return !file || /\.(test|type-test)\.[jt]s$/.test(path) || path.endsWith('.d.ts') ? [] : [{ path, ...file }];
  });
  const packages = packagesWithTexts(root);
  // Exactly when both have texts: a namespace one package and one module of the app both fill would have to be merged by guesswork.
  for (const surface of packages) {
    if (files.some((file) => file.namespace === surface.namespace)) {
      throw new MessageError(
        `[marmeon:S7] The namespace "${surface.namespace}" has texts in ${surface.package} and in the app's modules/${surface.namespace}/lang — rename the module, and reword the package's texts in lang/${surface.namespace}/<locale>.ts.`,
      );
    }
  }
  for (const { path, ...file } of files) {
    if (file.namespace === 'marmeon') throw new Error(`${path}: the namespace "marmeon" belongs to the framework — rename the module.`);
    const locale = addLocale(locales, file.locale);
    if (!locale) {
      skipped.push(path);
      continue;
    }
    const module = (await importLangFile(pathToFileURL(path).href)) as { default?: unknown };
    catalog.add(locale, file.namespace, module.default, path);
    loaded.push(path);
  }
  const reworded = new Set<string>();
  for (const { path, locale: tag } of await overrideFiles(root, FRAMEWORK.namespace)) {
    const locale = addLocale(locales, tag);
    if (!locale) {
      skipped.push(path);
      continue;
    }
    if (reworded.has(locale)) throw new MessageError(`The marmeon messages in ${locale} are defined twice (${path}).`);
    reworded.add(locale);
    const tree = await importTexts(path);
    checkOverride(path, root, tree, frameworkEn, FRAMEWORK);
    catalog.replace(locale, 'marmeon', mergeTexts(frameworkTexts.get(locale) ?? {}, tree), `${frameworkTexts.has(locale) ? `@marmeon/i18n (${locale}) + ` : ''}${path}`);
    loaded.push(path);
  }
  for (const surface of packages) await loadPackageTexts(root, surface, catalog, locales, loaded, skipped);
  return { loaded, skipped };
}

/**
 * Registers the translations (`Catalog`, loaded at boot), `Translators` (any locale, anywhere), the request's
 * `Translator`, `UrlLocales` (what localized routes need) and `SetLocale` in the `web` group. Found by `marmeon discover`.
 */
export class I18nServiceProvider implements ServiceProvider {
  static config = [I18nConfig];
  /** `marmeon publish @marmeon/i18n --only=lang` copies the framework's texts into the app's `lang/marmeon/`. */
  static publishes = { lang: new URL('../stubs/lang', import.meta.url) };

  register(container: Container): void {
    const config = container.make(I18nConfig);
    const locales = new Locales(config);
    const catalog = new Catalog({ fallback: locales.fallback }).add('en', 'marmeon', frameworkEn, '@marmeon/i18n (en)').add('de', 'marmeon', frameworkDe, '@marmeon/i18n (de)');
    container.instance(Locales, locales);
    container.instance(Catalog, catalog);
    container.instance(Translators, new Translators(catalog, locales, config.timeZone));
    // The request's locale (SetLocale sets it); in any other scope — a job, a command — APP_LOCALE.
    container.scoped(CurrentLocale, () => new CurrentLocale(locales.default));
    container.scoped(Translator, (c) => {
      const current = c.make(CurrentLocale);
      return createTranslator(catalog, () => current.value, { locales: () => locales.supported, timeZone: config.timeZone });
    });
    container.scoped(RequestLocale, (c) => new RequestLocale(c.make(CurrentLocale), locales));
    container.scoped(LocalePreference, () => ({ preferredLocale: () => undefined }));
    container.scoped(PreferredLocale, (c) => ({
      get value() {
        return epochLocaleOf.get(c.make(CurrentLocale));
      },
    }));
    container.scoped(PageAlternates);
    // Resolved when the chain needs it: a localized route in a group without a session never touches one.
    container.scoped(SetLocale, (c) => new SetLocale(c.make(CurrentLocale), () => c.make(Session), c.make(LocalePreference), locales, (paths, source) => c.make(PageAlternates).set(paths, source)));
    // What `Route.localized()` needs: the locales a URL can name, and where the URL without one leads.
    container.instance(UrlLocales, {
      get supported() {
        return locales.supported;
      },
      // `SetLocale` ran in the route's group and chose; a group without it falls back to the browser's languages.
      preferred: async (ctx) => preferredOf.get(ctx.request) ?? negotiateLocale(ctx.request.headers.get('accept-language'), locales.supported) ?? locales.default,
    });
  }

  async boot(app: Application): Promise<void> {
    const locales = app.container.make(Locales);
    const { skipped } = await loadLangFiles(app.root, app.container.make(Catalog), locales);
    if (skipped.length > 0) {
      app.container.make(Logger).debug(`Language files of locales not in APP_LOCALES (${locales.supported.join(', ')}) are not loaded`, { files: skipped });
    }
    app.container.make(Router).middleware.append('web', SetLocale, MiddlewarePriority.setLocale);
  }
}

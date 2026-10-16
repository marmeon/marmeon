import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Application, defineConfig, env, Logger, token, type ConfigOf, type Container, type ServiceProvider } from '@marmeon/core';
import { editableResponse, MiddlewarePriority, Router, translatable, type HttpContext, type Next } from '@marmeon/router';
import { Session } from '@marmeon/session';
import { Catalog } from './catalog.ts';
import frameworkDe from './lang/de.ts';
import frameworkEn from './lang/en.ts';
import { langFileOf } from './loader.ts';
import { isLanguageTag, negotiateLocale, supportedLocale } from './locale.ts';
import { createTranslator, CurrentLocale, Translator } from './translator.ts';
import type { CheckTranslationKey, MessageOf, ParamsOf, TranslationKey } from './types.ts';

export { Catalog, createMessageLoader, createTranslate, MessageError, MessageSyntaxError } from './messages.ts';
export type { CheckKey, Formatter, KeyOf, LangFiles, MessageAt, MessageLoader, Messages, MessagesOf, MessageTree, Namespace, ParamsOf, Translate, TranslateArgs, Translations } from './messages.ts';
export { CurrentLocale, Translator } from './translator.ts';
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
    return { locale: spell(e.APP_LOCALE), fallback: spell(e.APP_FALLBACK_LOCALE), locales: explicit };
  },
});
export type I18nConfig = ConfigOf<typeof I18nConfig>;

/**
 * The app's locales: the default (`APP_LOCALE`), the fallback and the supported ones — `APP_LOCALES`, else every locale
 * the app has language files for. The allow-list every value from a request is checked against. Fixed once booted.
 */
export class Locales {
  readonly default: string;
  readonly fallback: string;
  /** Whether `APP_LOCALES` names them (else the language files do). */
  readonly explicit: boolean;
  #supported: string[];

  constructor(config: I18nConfig) {
    this.default = config.locale;
    this.fallback = config.fallback;
    this.explicit = config.locales !== undefined;
    this.#supported = [...new Set([config.locale, ...(config.locales ?? [config.fallback])])];
  }

  /** The default first. */
  get supported(): readonly string[] {
    return this.#supported;
  }

  /** The supported locale `value` names (in its spelling), or undefined — for values from outside. */
  find(value: unknown): string | undefined {
    return supportedLocale(value, this.#supported);
  }

  /** At boot: a locale the app has language files for (ignored when `APP_LOCALES` names them). */
  add(locale: string): string | undefined {
    if (this.explicit) return this.find(locale);
    const known = this.find(locale);
    if (known) return known;
    this.#supported = [...this.#supported, locale];
    return locale;
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
  readonly #cache = new Map<string, Translator>();

  constructor(catalog: Catalog, locales: Locales) {
    this.#catalog = catalog;
    this.#locales = locales;
  }

  /** A translator fixed to `locale` — or to `APP_LOCALE` when `locale` is none of the supported ones (or missing). */
  for(locale: string | null | undefined): Translator {
    const fixed = this.#locales.find(locale) ?? this.#locales.default;
    let translator = this.#cache.get(fixed);
    if (!translator) {
      translator = createTranslator(this.#catalog, () => fixed, { locales: () => this.#locales.supported });
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
 * Sets the request's locale — the first supported one of: the session's (`locale`, a language switcher), the
 * signed-in user's ({@link LocalePreference}), the browser's (`Accept-Language`), `APP_LOCALE`. In the `web` group,
 * after the session, before CSRF verification (its 419 page is translated too).
 *
 * No value from the request becomes a locale unless it is a supported one ({@link Locales}) — in its spelling: what reaches
 * `<html lang>`, the page's `locale` and the browser's language files is always one of the app's own. With several
 * supported locales the answer depends on `Accept-Language`, so it carries `Vary: accept-language`; with one, nothing
 * is negotiated and no `Vary` is sent (every answer is in that locale).
 */
export class SetLocale {
  readonly #current: CurrentLocale;
  readonly #session: Session;
  readonly #preference: LocalePreference;
  readonly #locales: Locales;

  constructor(current: CurrentLocale, session: Session, preference: LocalePreference, locales: Locales) {
    this.#current = current;
    this.#session = session;
    this.#preference = preference;
    this.#locales = locales;
  }

  async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const locales = this.#locales;
    // One supported locale: every answer is in it — nothing to choose, and nothing caches must keep apart.
    const choice = locales.supported.length > 1;
    const locale = choice
      ? (locales.find(this.#session.get('locale')) ??
        locales.find(await this.#preference.preferredLocale()) ??
        negotiateLocale(ctx.request.headers.get('accept-language'), locales.supported) ??
        locales.default)
      : locales.default;
    this.#current.set(locale);

    const localized = editableResponse(await next());
    localized.headers.set('content-language', locale);
    if (!choice) return localized;
    // The answer depends on the browser's languages (for visitors without a choice): caches must keep them apart.
    const vary = localized.headers.get('vary');
    if (!vary?.toLowerCase().split(/\s*,\s*/).includes('accept-language')) localized.headers.set('vary', vary ? `${vary}, accept-language` : 'accept-language');
    return localized;
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
  params?: Partial<ParamsOf<MessageOf<K>>>,
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

/**
 * Loads the app's language files into `catalog` — the locales `locales` accepts (all, unless `APP_LOCALES` names
 * them; a file for another locale is skipped). The paths come from the app's folders, never from a request.
 */
async function loadLangFiles(root: string, catalog: Catalog, locales: Locales): Promise<{ loaded: string[]; skipped: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const path of await langFiles(root)) {
    const file = langFileOf(path.slice(root.length));
    if (!file || /\.(test|type-test)\.[jt]s$/.test(path) || path.endsWith('.d.ts')) continue;
    if (file.namespace === 'marmeon') throw new Error(`${path}: the namespace "marmeon" belongs to the framework — rename the module.`);
    const locale = locales.add(file.locale);
    if (!locale) {
      skipped.push(path);
      continue;
    }
    const module = (await importLangFile(pathToFileURL(path).href)) as { default?: unknown };
    catalog.add(locale, file.namespace, module.default, path);
    loaded.push(path);
  }
  return { loaded, skipped };
}

/**
 * Registers the translations (`Catalog`, loaded at boot), `Translators` (any locale, anywhere), the request's
 * `Translator` and `SetLocale` in the `web` group. Found by `marmeon discover`.
 */
export class I18nServiceProvider implements ServiceProvider {
  static config = [I18nConfig];

  register(container: Container): void {
    const locales = new Locales(container.make(I18nConfig));
    const catalog = new Catalog({ fallback: locales.fallback }).add('en', 'marmeon', frameworkEn, '@marmeon/i18n (en)').add('de', 'marmeon', frameworkDe, '@marmeon/i18n (de)');
    container.instance(Locales, locales);
    container.instance(Catalog, catalog);
    container.instance(Translators, new Translators(catalog, locales));
    // The request's locale (SetLocale sets it); in any other scope — a job, a command — APP_LOCALE.
    container.scoped(CurrentLocale, () => new CurrentLocale(locales.default));
    container.scoped(Translator, (c) => {
      const current = c.make(CurrentLocale);
      return createTranslator(catalog, () => current.value, { locales: () => locales.supported });
    });
    container.scoped(LocalePreference, () => ({ preferredLocale: () => undefined }));
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

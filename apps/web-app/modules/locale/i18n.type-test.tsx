// Type guarantees of the translations — compiled by `pnpm typecheck` / `marmeon build`, never run.
import type { Messages } from '@marmeon/i18n/messages';
import { trans, type Translator } from '@marmeon/i18n';
import { useTranslation } from '@marmeon/react';
import type en from '../auth/lang/en.ts';

export function MissingKeyInATranslation() {
  const de = {} as Messages<typeof en>;
  const { failed: _failed, ...login } = de.login;
  return {
    ...de,
    // @ts-expect-error — `failed` is missing in the translation of `login` (every key of en.ts is required)
    login,
  } satisfies Messages<typeof en>;
}

export function WrongPlaceholder() {
  const de = {} as Messages<typeof en>;
  return {
    ...de,
    // @ts-expect-error — en.ts has {app}: a translation must keep the placeholder
    login: { ...de.login, heading: 'Bei {name} anmelden' },
  } satisfies Messages<typeof en>;
}

export function UnknownKeyInT() {
  const t = useTranslation('auth');
  t('login.title');
  t('login.throttled', { seconds: 30 });
  // @ts-expect-error — not a key of the auth messages (did you mean login.title?)
  t('login.titel');
  // @ts-expect-error — the text has a placeholder: its value is required
  t('login.throttled');
  // @ts-expect-error — `secs` is not a placeholder of the text
  t('login.throttled', { secs: 30 });
  // @ts-expect-error — a plural takes a number
  t('login.throttled', { seconds: 'thirty' });
  // @ts-expect-error — not a namespace (a module's name, or `app`)
  useTranslation('auht');
  return null;
}

export function OnTheServer(translator: Translator) {
  translator.get('auth.login.failed');
  translator.get('user-profile.show.stats_text', { links: 2, number: 1, members: 3 });
  // @ts-expect-error — not a key of the auth messages
  translator.get('auth.login.faild');
  // @ts-expect-error — not a namespace
  translator.get('auht.login.failed');
  // @ts-expect-error — keys of request schemas are checked too
  trans('auth.validation.emial_invalid');
}

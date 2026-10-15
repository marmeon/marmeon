import { useEffect, useState } from 'react';
import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';
import { getPasskey, passkeysAvailable, postJson } from '../passkeys.ts';

/** `passkey`: the account has a passkey that can confirm instead of the password; the button appears after hydration, in a browser that can use one. */
export default function ConfirmPassword({ passkey }: { passkey: boolean }) {
  const route = useRoute();
  const t = useTranslation('auth');
  const form = useForm('auth.password.confirm.store', { password: '' });
  // Known after hydration only (the server cannot ask the browser).
  const [browserHasPasskeys, setBrowserHasPasskeys] = useState(false);
  useEffect(() => setBrowserHasPasskeys(passkeysAvailable()), []);
  const [passkeyWorking, setPasskeyWorking] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  async function usePasskey() {
    setPasskeyWorking(true);
    setPasskeyError(null);
    try {
      const options = await postJson(route('auth.password.confirm.passkey.options'));
      if (!options.ok) throw Object.assign(new Error('options'), { data: options.data });
      const response = await getPasskey(options.data);
      // Success is a redirect to the page that asked for the confirmation; postJson follows it.
      const done = await postJson(route('auth.password.confirm.passkey'), { response });
      if (!done.ok) setPasskeyError(typeof done.data.error === 'string' ? done.data.error : t('passkeys.failed'));
    } catch (error) {
      const data = (error as { data?: { error?: unknown } }).data;
      setPasskeyError(typeof data?.error === 'string' ? data.error : t('passkeys.cancelled'));
    } finally {
      setPasskeyWorking(false);
    }
  }

  return (
    <main>
      <Head title={t('confirm.title')} />
      <h1>{t('confirm.title')}</h1>
      <p>{t('confirm.intro')}</p>
      <form
        method="post"
        action={route('auth.password.confirm.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onFinish: () => form.reset('password') });
        }}
      >
        <p>
          <label htmlFor="password">{t('confirm.password')}</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={form.data.password}
            onChange={(e) => form.set('password', e.target.value)}
            aria-invalid={!!form.errors.password}
          />
          {form.errors.password && <small role="alert"> {form.errors.password}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          {t('confirm.submit')}
        </button>
      </form>
      {passkey && browserHasPasskeys && (
        <p>
          <button type="button" onClick={() => void usePasskey()} disabled={passkeyWorking}>
            {passkeyWorking ? t('passkeys.working') : t('confirm.passkey')}
          </button>
          {passkeyError && <small role="alert"> {passkeyError}</small>}
        </p>
      )}
    </main>
  );
}

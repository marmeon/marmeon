import { useEffect, useState } from 'react';
import { getPasskey, passkeysAvailable, postJson } from '@marmeon/auth/passkeys/browser';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';

export default function TwoFactorChallenge({ totp, passkey }: { totp: boolean; passkey: boolean }) {
  const route = useRoute();
  const t = useTranslation('auth');
  // Without an authenticator app on the account the recovery code is the form's only field.
  const [recovery, setRecovery] = useState(!totp);
  // Known after hydration only (the server cannot ask the browser): the button appears then.
  const [browserHasPasskeys, setBrowserHasPasskeys] = useState(false);
  useEffect(() => setBrowserHasPasskeys(passkeysAvailable()), []);
  const [passkeyWorking, setPasskeyWorking] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  // Method, URL and errors come from the route (auth.two-factor.challenge.store → TwoFactorChallengeController's request).
  const form = useForm('auth.two-factor.challenge.store', { code: '', recovery_code: '' });
  const field = recovery ? 'recovery_code' : 'code';

  async function usePasskey() {
    setPasskeyWorking(true);
    setPasskeyError(null);
    try {
      const options = await postJson(route('auth.passkeys.challenge.options'));
      if (!options.ok) throw Object.assign(new Error('options'), { data: options.data });
      const response = await getPasskey(options.data);
      const done = await postJson(route('auth.passkeys.challenge'), { response });
      if (!done.ok) {
        // The wait ended (too long, too many wrong tries): the password is typed again.
        if (done.data.login === true) window.location.assign(route('auth.login'));
        else setPasskeyError(typeof done.data.error === 'string' ? done.data.error : t('passkeys.failed'));
      }
    } catch (error) {
      const data = (error as { data?: { error?: unknown } }).data;
      setPasskeyError(typeof data?.error === 'string' ? data.error : t('passkeys.cancelled'));
    } finally {
      setPasskeyWorking(false);
    }
  }

  return (
    <main>
      <Head title={t('two_factor.challenge_title')} />
      <h1>{t('two_factor.challenge_title')}</h1>
      {passkey && browserHasPasskeys && (
        <p>
          <button type="button" onClick={() => void usePasskey()} disabled={passkeyWorking}>
            {passkeyWorking ? t('passkeys.working') : t('passkeys.use')}
          </button>
          {passkeyError && <small role="alert"> {passkeyError}</small>}
        </p>
      )}
      <p>{!totp && passkey ? t('passkeys.or_recovery') : recovery ? t('two_factor.recovery_intro') : t('two_factor.challenge_intro')}</p>
      <form
        method="post"
        action={route('auth.two-factor.challenge.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onFinish: () => form.reset() });
        }}
      >
        <p>
          <label htmlFor={field}>{recovery ? t('two_factor.recovery_code') : t('two_factor.code')}</label>
          <br />
          <input
            id={field}
            name={field}
            type="text"
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete={recovery ? 'off' : 'one-time-code'}
            autoFocus={totp || !passkey}
            value={form.data[field]}
            onChange={(e) => form.set(field, e.target.value)}
            aria-invalid={!!form.errors[field]}
          />
          {form.errors[field] && <small role="alert"> {form.errors[field]}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          {form.processing ? t('two_factor.submitting') : t('two_factor.submit')}
        </button>
      </form>
      <p>
        {totp && (
          <>
            <button
              type="button"
              onClick={() => {
                form.reset();
                setRecovery(!recovery);
              }}
            >
              {recovery ? t('two_factor.use_app') : t('two_factor.use_recovery')}
            </button>{' '}
            ·{' '}
          </>
        )}
        <Link route="auth.login">{t('two_factor.back')}</Link>
      </p>
    </main>
  );
}

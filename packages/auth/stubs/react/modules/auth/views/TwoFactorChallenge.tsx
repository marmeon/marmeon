import { useEffect, useState } from 'react';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { getPasskey, passkeysAvailable, postJson } from '../passkeys.ts';

/** `totp` and `passkey`: which factors the account has — the page offers the authenticator app's code and a passkey accordingly (recovery codes always). */
export default function TwoFactorChallenge({ totp, passkey }: { totp: boolean; passkey: boolean }) {
  const route = useRoute();
  const t = useTranslation('auth');
  // Known after hydration only (the server cannot ask the browser): the button appears then.
  const [browserHasPasskeys, setBrowserHasPasskeys] = useState(false);
  useEffect(() => setBrowserHasPasskeys(passkeysAvailable()), []);
  const [passkeyWorking, setPasskeyWorking] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  // Both forms post to the same route (auth.two-factor.challenge.store → TwoFactorChallengeController): the code of the app, or a
  // recovery code. Two forms, so the second works without JavaScript too — a plain post, vouched for by the browser's Fetch Metadata.
  const codeForm = useForm('auth.two-factor.challenge.store', { code: '' });
  const recoveryForm = useForm('auth.two-factor.challenge.store', { recovery_code: '' });

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
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('two_factor.challenge_title')} />
        <h1>{t('two_factor.challenge_title')}</h1>
        {passkey && browserHasPasskeys && (
          <div className="auth-alternative">
            <button type="button" className="button auth-submit" onClick={() => void usePasskey()} disabled={passkeyWorking}>
              {passkeyWorking ? t('passkeys.working') : t('passkeys.use')}
            </button>
            {passkeyError && <small role="alert">{passkeyError}</small>}
          </div>
        )}
        {totp ? (
          <>
            <p>{t('two_factor.challenge_intro')}</p>
            <form
              method="post"
              action={route('auth.two-factor.challenge.store')}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void codeForm.submit({ onFinish: () => codeForm.reset() });
              }}
            >
              <div className="field">
                <label htmlFor="code">{t('two_factor.code')}</label>
                <input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus={!passkey}
                  value={codeForm.data.code}
                  onChange={(e) => codeForm.set('code', e.target.value)}
                  aria-invalid={!!codeForm.errors.code}
                />
                {codeForm.errors.code && <small role="alert"> {codeForm.errors.code}</small>}
              </div>
              <button type="submit" className="button auth-submit" disabled={codeForm.processing}>
                {codeForm.processing ? t('two_factor.submitting') : t('two_factor.submit')}
              </button>
            </form>

            <hr />
            <p>{t('two_factor.recovery_intro')}</p>
          </>
        ) : (
          <p>{t('passkeys.or_recovery')}</p>
        )}
        <form
          method="post"
          action={route('auth.two-factor.challenge.store')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void recoveryForm.submit({ onFinish: () => recoveryForm.reset() });
          }}
        >
          <div className="field">
            <label htmlFor="recovery_code">{t('two_factor.recovery_code')}</label>
            <input
              id="recovery_code"
              name="recovery_code"
              type="text"
              autoComplete="off"
              value={recoveryForm.data.recovery_code}
              onChange={(e) => recoveryForm.set('recovery_code', e.target.value)}
              aria-invalid={!!recoveryForm.errors.recovery_code}
            />
            {recoveryForm.errors.recovery_code && <small role="alert"> {recoveryForm.errors.recovery_code}</small>}
          </div>
          <button type="submit" className="button-secondary auth-submit" disabled={recoveryForm.processing}>
            {t('two_factor.use_recovery')}
          </button>
        </form>
        <p className="cluster auth-card-footer">
          <Link route="auth.login">{t('two_factor.back')}</Link>
        </p>
      </div>
    </main>
  );
}

TwoFactorChallenge.layout = AppLayout;

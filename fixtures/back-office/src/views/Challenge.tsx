import { useEffect, useState } from 'react';
import { getPasskey, passkeysAvailable, postJson } from '@marmeon/auth/passkeys/browser';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { OfficeTwoFactorChallengeController } from '../OfficeTwoFactorChallengeController.ts';

/**
 * The second factor, at the sign-in (`step` is `sign-in`) or when a signed-in session proves one again (`verify`). `totp` and `passkey` say which factors
 * the editor has: the page offers the authenticator app's code and a passkey accordingly, and a recovery code always.
 */
export default function Challenge({ step, totp, passkey }: { step: 'sign-in' | 'verify'; totp: boolean; passkey: boolean }) {
  const route = useRoute();
  const t = useTranslation('office');
  const verify = step === 'verify';
  const submitRoute = verify ? 'office.two-factor.verify.store' : 'office.two-factor.challenge.store';
  const optionsRoute = verify ? 'office.passkeys.step-up.options' : 'office.passkeys.challenge.options';
  const answerRoute = verify ? 'office.passkeys.step-up' : 'office.passkeys.challenge';
  // Known after hydration only (the server cannot ask the browser): the button appears then.
  const [browserHasPasskeys, setBrowserHasPasskeys] = useState(false);
  useEffect(() => setBrowserHasPasskeys(passkeysAvailable()), []);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Both forms post to the same route: the code of the app, or a recovery code. One form would post both fields, and the controller prefers a non-empty
  // `recovery_code`, so a code typed beside a stale recovery code would be ignored; two forms send one field each, and work without JavaScript too.
  const codeForm = useForm<OfficeTwoFactorChallengeController>({ code: '', recovery_code: '' });
  const recoveryForm = useForm<OfficeTwoFactorChallengeController>({ code: '', recovery_code: '' });

  async function usePasskey() {
    setWorking(true);
    setProblem(null);
    try {
      const options = await postJson(route(optionsRoute));
      if (!options.ok) throw Object.assign(new Error('options'), { data: options.data });
      const response = await getPasskey(options.data);
      const done = await postJson(route(answerRoute), { response });
      if (!done.ok) {
        // The wait ended (too long, too many wrong tries): the password is typed again.
        if (done.data.login === true) window.location.assign(route('office.login'));
        else setProblem(typeof done.data.error === 'string' ? done.data.error : t('challenge.failed'));
      }
    } catch (error) {
      const data = (error as { data?: { error?: unknown } }).data;
      setProblem(typeof data?.error === 'string' ? data.error : t('challenge.cancelled'));
    } finally {
      setWorking(false);
    }
  }

  return (
    <main data-area="office">
      <Head title={verify ? t('challenge.verifyTitle') : t('challenge.signInTitle')} />
      <h1>{verify ? t('challenge.verifyTitle') : t('challenge.signInTitle')}</h1>
      {passkey && browserHasPasskeys && (
        <p>
          <button type="button" onClick={() => void usePasskey()} disabled={working}>
            {working ? t('challenge.passkeyWorking') : t('challenge.passkey')}
          </button>
          {problem && <small role="alert"> {problem}</small>}
        </p>
      )}
      {totp ? (
        <>
          <p>{verify ? t('challenge.verifyIntro') : t('challenge.signInIntro')}</p>
          <form
            method="post"
            action={route(submitRoute)}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void codeForm.post(route(submitRoute), { onFinish: () => codeForm.reset() });
            }}
          >
            <p>
              <label htmlFor="code">{t('challenge.code')}</label>
              <br />
              <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" value={codeForm.data.code} onChange={(e) => codeForm.set('code', e.target.value)} aria-invalid={!!codeForm.errors.code} />
              {codeForm.errors.code && <small role="alert"> {codeForm.errors.code}</small>}
            </p>
            <button type="submit" disabled={codeForm.processing}>
              {codeForm.processing ? t('challenge.submitting') : t('challenge.submit')}
            </button>
          </form>
          <p>{t('challenge.recoveryIntro')}</p>
        </>
      ) : (
        <p>{t('challenge.passkeyOrRecovery')}</p>
      )}
      <form
        method="post"
        action={route(submitRoute)}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void recoveryForm.post(route(submitRoute), { onFinish: () => recoveryForm.reset() });
        }}
      >
        <p>
          <label htmlFor="recovery_code">{t('challenge.recoveryCode')}</label>
          <br />
          <input id="recovery_code" name="recovery_code" type="text" autoComplete="off" value={recoveryForm.data.recovery_code} onChange={(e) => recoveryForm.set('recovery_code', e.target.value)} aria-invalid={!!recoveryForm.errors.recovery_code} />
          {recoveryForm.errors.recovery_code && <small role="alert"> {recoveryForm.errors.recovery_code}</small>}
        </p>
        <button type="submit" disabled={recoveryForm.processing}>
          {t('challenge.useRecovery')}
        </button>
      </form>
      <p>{verify ? <Link route="office.index">{t('security.back')}</Link> : <Link route="office.login">{t('challenge.back')}</Link>}</p>
    </main>
  );
}

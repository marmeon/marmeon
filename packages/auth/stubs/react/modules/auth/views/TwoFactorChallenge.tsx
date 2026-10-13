import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

export default function TwoFactorChallenge() {
  const route = useRoute();
  const t = useTranslation('auth');
  // Both forms post to the same route (auth.two-factor.challenge.store → TwoFactorChallengeController): the code of the app, or a
  // recovery code. Two forms, so the second works without JavaScript too — a plain post, vouched for by the browser's Fetch Metadata.
  const codeForm = useForm('auth.two-factor.challenge.store', { code: '' });
  const recoveryForm = useForm('auth.two-factor.challenge.store', { recovery_code: '' });

  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('two_factor.challenge_title')} />
        <h1>{t('two_factor.challenge_title')}</h1>
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
              autoFocus
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

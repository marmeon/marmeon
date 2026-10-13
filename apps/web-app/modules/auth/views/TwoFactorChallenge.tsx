import { useState } from 'react';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';

export default function TwoFactorChallenge() {
  const route = useRoute();
  const t = useTranslation('auth');
  const [recovery, setRecovery] = useState(false);
  // Method, URL and errors come from the route (auth.two-factor.challenge.store → TwoFactorChallengeController's request).
  const form = useForm('auth.two-factor.challenge.store', { code: '', recovery_code: '' });
  const field = recovery ? 'recovery_code' : 'code';

  return (
    <main>
      <Head title={t('two_factor.challenge_title')} />
      <h1>{t('two_factor.challenge_title')}</h1>
      <p>{recovery ? t('two_factor.recovery_intro') : t('two_factor.challenge_intro')}</p>
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
            autoFocus
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
        <button
          type="button"
          onClick={() => {
            form.reset();
            setRecovery(!recovery);
          }}
        >
          {recovery ? t('two_factor.use_app') : t('two_factor.use_recovery')}
        </button>{' '}
        · <Link route="auth.login">{t('two_factor.back')}</Link>
      </p>
    </main>
  );
}

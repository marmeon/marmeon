import { useState } from 'react';
import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';

/** Proves the second factor again in the session that is already signed in (`TwoFactor.stepUp()`). */
export default function TwoFactorVerify() {
  const route = useRoute();
  const t = useTranslation('auth');
  const [recovery, setRecovery] = useState(false);
  const form = useForm('auth.two-factor.verify.store', { code: '', recovery_code: '' });
  const field = recovery ? 'recovery_code' : 'code';

  return (
    <main>
      <Head title={t('two_factor.verify_title')} />
      <h1>{t('two_factor.verify_title')}</h1>
      <p>{recovery ? t('two_factor.recovery_intro') : t('two_factor.verify_intro')}</p>
      <form
        method="post"
        action={route('auth.two-factor.verify.store')}
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
        </button>
      </p>
    </main>
  );
}

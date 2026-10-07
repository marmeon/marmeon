import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';

export default function ForgotPassword() {
  const route = useRoute();
  const t = useTranslation('auth');
  // Method, URL and fields from the route: auth.password.email → SendPasswordResetLinkController's request.
  const form = useForm('auth.password.email', { email: '' });

  return (
    <main>
      <Head title={t('forgot.title')} />
      <h1>{t('forgot.title')}</h1>
      <p>{t('forgot.intro')}</p>
      <form
        method="post"
        action={route('auth.password.email')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onSuccess: () => form.reset() });
        }}
      >
        <p>
          <label htmlFor="email">{t('forgot.email')}</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={form.data.email}
            onChange={(e) => form.set('email', e.target.value)}
            aria-invalid={!!form.errors.email}
          />
          {form.errors.email && <small role="alert"> {form.errors.email}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          {t('forgot.submit')}
        </button>
      </form>
      <p>
        <Link route="auth.login">{t('forgot.back')}</Link>
      </p>
    </main>
  );
}

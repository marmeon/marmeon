import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

export default function ForgotPassword() {
  const route = useRoute();
  const t = useTranslation('auth');
  // Method, URL and fields from the route: auth.password.email → SendPasswordResetLinkController's request.
  const form = useForm('auth.password.email', { email: '' });

  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('forgot.title')} />
        <h1>{t('forgot.title')}</h1>
        <p className="muted">{t('forgot.intro')}</p>
        <form
          method="post"
          action={route('auth.password.email')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({ onSuccess: () => form.reset() });
          }}
        >
          <div className="field">
            <label htmlFor="email">{t('forgot.email')}</label>
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
          </div>
          <button type="submit" className="button auth-submit" disabled={form.processing}>
            {t('forgot.submit')}
          </button>
        </form>
        <p className="auth-card-footer">
          <Link route="auth.login">{t('forgot.back')}</Link>
        </p>
      </div>
    </main>
  );
}

ForgotPassword.layout = AppLayout;

import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../layouts/AppLayout.tsx';

export default function ConfirmPassword() {
  const route = useRoute();
  const t = useTranslation('auth');
  const form = useForm('auth.password.confirm.store', { password: '' });

  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('confirm.title')} />
        <h1>{t('confirm.title')}</h1>
        <p className="muted">{t('confirm.intro')}</p>
        <form
          method="post"
          action={route('auth.password.confirm.store')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({ onFinish: () => form.reset('password') });
          }}
        >
          <div className="field">
            <label htmlFor="password">{t('confirm.password')}</label>
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
          </div>
          <button type="submit" className="button auth-submit" disabled={form.processing}>
            {t('confirm.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}

ConfirmPassword.layout = AppLayout;

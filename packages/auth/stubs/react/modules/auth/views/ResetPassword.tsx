import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ShowResetPasswordController } from '../controllers/ShowResetPasswordController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowResetPasswordController>;

export default function ResetPassword({ email }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  const form = useForm('auth.password.store', { password: '', password_confirmation: '' });

  if (email === null) {
    return (
      <main className="app-main">
        <div className="card auth-card">
          <Head title={t('reset.title')} />
          <h1>{t('reset.expired')}</h1>
          <p>
            {t('reset.expired_text')} <Link route="auth.password.request">{t('reset.ask')}</Link>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('reset.title')} />
        <h1>{t('reset.heading')}</h1>
        <p>{t('reset.for', { email })}</p>
        <form
          method="post"
          action={route('auth.password.store')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({ onFinish: () => form.reset() });
          }}
        >
          {(
            [
              ['password', t('reset.password', { min: 8 })],
              ['password_confirmation', t('reset.password_confirmation')],
            ] as const
          ).map(([name, label]) => (
            <div className="field" key={name}>
              <label htmlFor={name}>{label}</label>
              <input
                id={name}
                name={name}
                type="password"
                autoComplete="new-password"
                value={form.data[name]}
                onChange={(e) => form.set(name, e.target.value)}
                aria-invalid={!!form.errors[name]}
              />
              {form.errors[name] && <small role="alert"> {form.errors[name]}</small>}
            </div>
          ))}
          <button type="submit" className="button auth-submit" disabled={form.processing}>
            {t('reset.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}

ResetPassword.layout = AppLayout;

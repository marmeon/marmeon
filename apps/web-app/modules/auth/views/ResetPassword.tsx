import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@bespokecore/react';
import type { ShowResetPasswordController } from '../controllers/ShowResetPasswordController.ts';

type Props = PageProps<ShowResetPasswordController>;

export default function ResetPassword({ email, csrfToken }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  const form = useForm('auth.password.store', { password: '', password_confirmation: '' });

  if (email === null) {
    return (
      <main>
        <Head title={t('reset.title')} />
        <h1>{t('reset.expired')}</h1>
        <p>
          {t('reset.expired_text')} <Link route="auth.password.request">{t('reset.ask')}</Link>.
        </p>
      </main>
    );
  }

  return (
    <main>
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
        <input type="hidden" name="_token" value={csrfToken} />
        {(
          [
            ['password', t('reset.password', { min: 8 })],
            ['password_confirmation', t('reset.password_confirmation')],
          ] as const
        ).map(([name, label]) => (
          <p key={name}>
            <label htmlFor={name}>{label}</label>
            <br />
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
          </p>
        ))}
        <button type="submit" disabled={form.processing}>
          {t('reset.submit')}
        </button>
      </form>
    </main>
  );
}

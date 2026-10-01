import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@bespokecore/react';
import type { ShowRegisterController } from '../controllers/ShowRegisterController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowRegisterController>;

export default function Register({ old, csrfToken }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  const form = useForm('auth.register.store', { name: old.name ?? '', email: old.email ?? '', password: '', password_confirmation: '' });
  const field = (name: 'name' | 'email' | 'password' | 'password_confirmation', label: string, type: string, autoComplete: string) => (
    <p>
      <label htmlFor={name}>{label}</label>
      <br />
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        value={form.data[name]}
        onChange={(e) => form.set(name, e.target.value)}
        aria-invalid={!!form.errors[name]}
      />
      {form.errors[name] && <small role="alert"> {form.errors[name]}</small>}
    </p>
  );

  return (
    <main>
      <Head title={t('register.title')} />
      <h1>{t('register.title')}</h1>
      <form
        method="post"
        action={route('auth.register.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onFinish: () => form.reset('password', 'password_confirmation') });
        }}
      >
        <input type="hidden" name="_token" value={csrfToken} />
        {field('name', t('register.name'), 'text', 'name')}
        {field('email', t('register.email'), 'email', 'email')}
        {field('password', t('register.password', { min: 8 }), 'password', 'new-password')}
        {field('password_confirmation', t('register.password_confirmation'), 'password', 'new-password')}
        <button type="submit" disabled={form.processing}>
          {form.processing ? t('register.submitting') : t('register.submit')}
        </button>
      </form>
      <p>
        {t('register.registered')} <Link route="auth.login">{t('register.login')}</Link>
      </p>
    </main>
  );
}

Register.layout = AppLayout;

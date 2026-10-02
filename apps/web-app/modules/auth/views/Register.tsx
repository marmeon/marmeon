import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@bespokecore/react';
import type { ShowRegisterController } from '../controllers/ShowRegisterController.ts';

type Props = PageProps<ShowRegisterController>;

export default function Register({ old, csrfToken }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  // Live validation (E62): name and e-mail are checked against the server's schema when you leave them — a taken address
  // shows before you send. Password fields never are (never sent for a check): their rules are checked on submit.
  const form = useForm(
    'auth.register.store',
    {},
    { name: old.name ?? '', email: old.email ?? '', password: '', password_confirmation: '' },
    { validate: { on: 'blur', fields: ['name', 'email'] } },
  );
  const field = (name: 'name' | 'email' | 'password' | 'password_confirmation', label: string, type: string, autoComplete: string, live?: 'name' | 'email') => (
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
        onBlur={live ? () => form.validate(live) : undefined}
        aria-invalid={!!form.errors[name]}
        aria-busy={(live && form.validating(live)) || undefined}
        aria-describedby={form.errors[name] ? `${name}-error` : undefined}
      />
      {live && form.validating(live) && <small> {t('register.checking')}</small>}
      {form.errors[name] && (
        <small id={`${name}-error`} role="alert">
          {' '}
          {form.errors[name]}
        </small>
      )}
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
        {field('name', t('register.name'), 'text', 'name', 'name')}
        {field('email', t('register.email'), 'email', 'email', 'email')}
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

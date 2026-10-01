import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@bespokecore/react';
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowLoginController>;

export default function Login({ appName, old, csrfToken }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  // Method, URL, fields and errors come from the route (auth.login.store → LoginController's LoginRequest).
  // The password never comes back from the server.
  const form = useForm('auth.login.store', { email: old.email ?? '', password: '', remember: false });

  return (
    <main>
      <Head title={t('login.title')} />
      <h1>{t('login.heading', { app: appName })}</h1>
      {/* Works without JavaScript too: a plain form post with the CSRF token. */}
      <form
        method="post"
        action={route('auth.login.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onFinish: () => form.set('password', '') });
        }}
      >
        <input type="hidden" name="_token" value={csrfToken} />
        <p>
          <label htmlFor="email">{t('login.email')}</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            value={form.data.email}
            onChange={(e) => form.set('email', e.target.value)}
            aria-invalid={!!form.errors.email}
          />
          {form.errors.email && <small role="alert"> {form.errors.email}</small>}
        </p>
        <p>
          <label htmlFor="password">{t('login.password')}</label>
          <br />
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
        </p>
        <p>
          <label>
            <input type="checkbox" name="remember" checked={form.data.remember === true} onChange={(e) => form.set('remember', e.target.checked)} /> {t('login.remember')}
          </label>
        </p>
        <button type="submit" disabled={form.processing}>
          {form.processing ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
      <p>
        <Link route="auth.password.request">{t('login.forgot')}</Link> · {t('login.new_here')} <Link route="auth.register">{t('login.register')}</Link>
      </p>
    </main>
  );
}

Login.layout = AppLayout;

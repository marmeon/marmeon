import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute } from '@bespokecore/react';
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';

type Props = PageProps<ShowLoginController>;

export default function Login({ appName, old, csrfToken }: Props) {
  const route = useRoute();
  // Method, URL, fields and errors come from the route (auth.login.store → LoginController's LoginRequest).
  // The password never comes back from the server.
  const form = useForm('auth.login.store', { email: old.email ?? '', password: '', remember: false });

  return (
    <main>
      <Head title="Sign in" />
      <h1>Sign in to {appName}</h1>
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
          <label htmlFor="email">E-mail</label>
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
          <label htmlFor="password">Password</label>
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
            <input type="checkbox" name="remember" checked={form.data.remember === true} onChange={(e) => form.set('remember', e.target.checked)} /> Keep me signed in
          </label>
        </p>
        <button type="submit" disabled={form.processing}>
          {form.processing ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p>
        <Link route="auth.password.request">Forgot your password?</Link> · New here? <Link route="auth.register">Create an account</Link>
      </p>
      <p>
        <small>Demo: ada@example.com, alan@example.com or grace@example.com — password <code>password</code>.</small>
      </p>
    </main>
  );
}

import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute } from '@bespokecore/react';
import type { ShowForgotPasswordController } from '../controllers/ShowForgotPasswordController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowForgotPasswordController>;

export default function ForgotPassword({ csrfToken }: Props) {
  const route = useRoute();
  // Method, URL and fields from the route: auth.password.email → SendPasswordResetLinkController's request.
  const form = useForm('auth.password.email', { email: '' });

  return (
    <main>
      <Head title="Forgot your password?" />
      <h1>Forgot your password?</h1>
      <p>Enter your e-mail address. If it belongs to an account, we send you a link to choose a new password.</p>
      <form
        method="post"
        action={route('auth.password.email')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit({ onSuccess: () => form.reset() });
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
            autoComplete="email"
            value={form.data.email}
            onChange={(e) => form.set('email', e.target.value)}
            aria-invalid={!!form.errors.email}
          />
          {form.errors.email && <small role="alert"> {form.errors.email}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          Send the link
        </button>
      </form>
      <p>
        <Link route="auth.login">Back to sign in</Link>
      </p>
    </main>
  );
}

ForgotPassword.layout = AppLayout;

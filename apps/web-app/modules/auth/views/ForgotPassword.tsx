import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { SendPasswordResetLinkController } from '../controllers/SendPasswordResetLinkController.ts';
import type { ShowForgotPasswordController } from '../controllers/ShowForgotPasswordController.ts';

type Props = PageProps<ShowForgotPasswordController>;

export default function ForgotPassword({ csrfToken, flash }: Props) {
  const form = useForm<SendPasswordResetLinkController>({ email: '' });

  return (
    <main>
      <Head title="Forgot your password?" />
      <h1>Forgot your password?</h1>
      <p>Enter your e-mail address. If it belongs to an account, we send you a link to choose a new password.</p>
      {flash.status && <p role="status">{flash.status}</p>}
      <form
        method="post"
        action="/forgot-password"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/forgot-password', { onSuccess: () => form.reset() });
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
        <Link href="/login">Back to sign in</Link>
      </p>
    </main>
  );
}

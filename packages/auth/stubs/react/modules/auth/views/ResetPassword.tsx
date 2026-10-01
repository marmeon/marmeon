import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm, useRoute } from '@bespokecore/react';
import type { ShowResetPasswordController } from '../controllers/ShowResetPasswordController.ts';

type Props = PageProps<ShowResetPasswordController>;

export default function ResetPassword({ email, csrfToken }: Props) {
  const route = useRoute();
  const form = useForm('auth.password.store', { password: '', password_confirmation: '' });

  if (email === null) {
    return (
      <main>
        <Head title="Reset your password" />
        <h1>This link has expired</h1>
        <p>
          Reset links work once, for a limited time. <Link route="auth.password.request">Ask for a new one</Link>.
        </p>
      </main>
    );
  }

  return (
    <main>
      <Head title="Reset your password" />
      <h1>Choose a new password</h1>
      <p>For {email}</p>
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
            ['password', 'New password (at least 8 characters)'],
            ['password_confirmation', 'Repeat the new password'],
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
          Set the new password
        </button>
      </form>
    </main>
  );
}

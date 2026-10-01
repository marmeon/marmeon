import type { PageProps } from '@bespokecore/http';
import { Head, useForm } from '@bespokecore/react';
import type { ConfirmPasswordController } from '../controllers/ConfirmPasswordController.ts';
import type { ShowConfirmPasswordController } from '../controllers/ShowConfirmPasswordController.ts';

type Props = PageProps<ShowConfirmPasswordController>;

export default function ConfirmPassword({ csrfToken }: Props) {
  const form = useForm<ConfirmPasswordController>({ password: '' });

  return (
    <main>
      <Head title="Confirm your password" />
      <h1>Confirm your password</h1>
      <p>This is a sensitive area. Please enter your password to continue.</p>
      <form
        method="post"
        action="/confirm-password"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/confirm-password', { onFinish: () => form.reset('password') });
        }}
      >
        <input type="hidden" name="_token" value={csrfToken} />
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
        <button type="submit" disabled={form.processing}>
          Confirm
        </button>
      </form>
    </main>
  );
}

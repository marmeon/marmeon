import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { RegisterController } from '../controllers/RegisterController.ts';
import type { ShowRegisterController } from '../controllers/ShowRegisterController.ts';

type Props = PageProps<ShowRegisterController>;

export default function Register({ old, csrfToken }: Props) {
  const form = useForm<RegisterController>({ name: old.name ?? '', email: old.email ?? '', password: '', password_confirmation: '' });
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
      <Head title="Create an account" />
      <h1>Create an account</h1>
      <form
        method="post"
        action="/register"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post('/register', { onFinish: () => form.reset('password', 'password_confirmation') });
        }}
      >
        <input type="hidden" name="_token" value={csrfToken} />
        {field('name', 'Name', 'text', 'name')}
        {field('email', 'E-mail', 'email', 'email')}
        {field('password', 'Password (at least 8 characters)', 'password', 'new-password')}
        {field('password_confirmation', 'Repeat the password', 'password', 'new-password')}
        <button type="submit" disabled={form.processing}>
          {form.processing ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p>
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}

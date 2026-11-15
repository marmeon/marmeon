import type { PageProps } from '@marmeon/http';
import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { OfficeLoginController } from '../OfficeLoginController.ts';
import type { ShowOfficeLoginController } from '../ShowOfficeLoginController.ts';

/** The editors' sign-in: the fields are the login request's, the errors come back by field, and the password never comes back from the server. */
export default function Login(_: PageProps<ShowOfficeLoginController>) {
  const route = useRoute();
  const t = useTranslation('office');
  const form = useForm<OfficeLoginController>({ email: '', password: '' });
  return (
    <main data-area="office">
      <Head title={t('login.title')} />
      <h1>{t('login.heading')}</h1>
      <p>{t('login.intro')}</p>
      <form
        method="post"
        action={route('office.login.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post(route('office.login.store'), { onFinish: () => form.set('password', '') });
        }}
      >
        <p>
          <label htmlFor="email">{t('login.email')}</label>
          <br />
          <input id="email" name="email" type="email" autoComplete="username" value={form.data.email} onChange={(e) => form.set('email', e.target.value)} aria-invalid={!!form.errors.email} />
          {form.errors.email && <small role="alert"> {form.errors.email}</small>}
        </p>
        <p>
          <label htmlFor="password">{t('login.password')}</label>
          <br />
          <input id="password" name="password" type="password" autoComplete="current-password" value={form.data.password} onChange={(e) => form.set('password', e.target.value)} aria-invalid={!!form.errors.password} />
          {form.errors.password && <small role="alert"> {form.errors.password}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          {form.processing ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </main>
  );
}

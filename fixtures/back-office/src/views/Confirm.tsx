import type { PageProps } from '@marmeon/http';
import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ConfirmController } from '../ConfirmController.ts';
import type { ShowConfirmController } from '../ShowConfirmController.ts';

/** The sudo mode's page: the editor's password again, for the back office's own window. */
export default function Confirm(_: PageProps<ShowConfirmController>) {
  const route = useRoute();
  const t = useTranslation('office');
  const form = useForm<ConfirmController>({ password: '' });
  return (
    <main data-area="office">
      <Head title={t('confirm.title')} />
      <h1>{t('confirm.title')}</h1>
      <p>{t('confirm.intro')}</p>
      <form
        method="post"
        action={route('office.confirm.store')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.post(route('office.confirm.store'), { onFinish: () => form.reset('password') });
        }}
      >
        <p>
          <label htmlFor="password">{t('confirm.password')}</label>
          <br />
          <input id="password" name="password" type="password" autoComplete="current-password" value={form.data.password} onChange={(e) => form.set('password', e.target.value)} aria-invalid={!!form.errors.password} />
          {form.errors.password && <small role="alert"> {form.errors.password}</small>}
        </p>
        <button type="submit" disabled={form.processing}>
          {t('confirm.submit')}
        </button>
      </form>
    </main>
  );
}

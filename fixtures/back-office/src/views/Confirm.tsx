import { useEffect, useState } from 'react';
import { getPasskey, passkeysAvailable, postJson } from '@marmeon/auth/passkeys/browser';
import type { PageProps } from '@marmeon/http';
import { Head, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ConfirmController } from '../ConfirmController.ts';
import type { ShowConfirmController } from '../ShowConfirmController.ts';

/** The sudo mode's page: the editor's password again, for the back office's own window. */
export default function Confirm(_: PageProps<ShowConfirmController>) {
  const route = useRoute();
  const t = useTranslation('office');
  const form = useForm<ConfirmController>({ password: '' });
  const [browserHasPasskeys, setBrowserHasPasskeys] = useState(false);
  useEffect(() => setBrowserHasPasskeys(passkeysAvailable()), []);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A passkey in place of the password: it opens the same sudo window.
  async function confirmWithPasskey() {
    setWorking(true);
    setProblem(null);
    try {
      const options = await postJson(route('office.confirm.passkey.options'));
      if (!options.ok) return setProblem(t('confirm.passkeyFailed'));
      const done = await postJson(route('office.confirm.passkey'), { response: await getPasskey(options.data) });
      if (!done.ok) setProblem(typeof done.data.error === 'string' ? done.data.error : t('confirm.passkeyFailed'));
    } catch {
      setProblem(t('confirm.passkeyFailed'));
    } finally {
      setWorking(false);
    }
  }
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
      {browserHasPasskeys && (
        <p>
          <button type="button" onClick={() => void confirmWithPasskey()} disabled={working}>
            {working ? t('confirm.passkeyWorking') : t('confirm.passkey')}
          </button>
          {problem && <small role="alert"> {problem}</small>}
        </p>
      )}
    </main>
  );
}

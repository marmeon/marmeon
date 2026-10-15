import { useEffect, useState } from 'react';
import type { PageProps } from '@marmeon/http';
import { Head, Link, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowPasskeysController } from '../controllers/ShowPasskeysController.ts';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';
import { createPasskey, passkeysAvailable, postJson } from '../passkeys.ts';

type Props = PageProps<ShowPasskeysController>;

export default function Passkeys({ passkeys, lastFactor, firstFactor, verified }: Props) {
  const t = useTranslation('auth');
  const route = useRoute();
  const [supported, setSupported] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ field?: string; message: string; sudo?: boolean; target?: { form: 'release' | 'remove'; id: number } } | null>(null);
  const [working, setWorking] = useState(false);
  // The recovery codes of the first factor are in this answer only — kept in this component's memory, gone when it closes.
  const [codes, setCodes] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<{ id: number; password: string } | null>(null);
  const [releasing, setReleasing] = useState<{ id: number; password: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  // In UTC: the server and the browser render the same text (no time zone of either side).
  const at = (iso: string | Date) => t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

  useEffect(() => setSupported(passkeysAvailable()), []);

  // Sudo mode ran out (423): the page asks for the password again, nothing is retried by itself.
  // `target` names the form of a row that asked: its message appears there, not under "Add a passkey".
  const fail = (result: { status: number; data: Record<string, any> }, target?: { form: 'release' | 'remove'; id: number }) =>
    setError({ field: result.data.field, message: typeof result.data.error === 'string' ? result.data.error : t('passkeys.register_failed'), sudo: result.status === 423, ...(target ? { target } : {}) });

  async function add() {
    setWorking(true);
    setError(null);
    try {
      const options = await postJson(route('auth.passkeys.options'));
      if (!options.ok) return fail(options);
      let credential;
      try {
        credential = await createPasskey(options.data);
      } catch {
        return setError({ message: t('passkeys.cancelled') });
      }
      const done = await postJson(route('auth.passkeys.store'), { response: credential, name: name.trim() || t('passkeys.name_default'), password });
      // The session ended while the passkey was being added (nothing was stored): the sign-in is the next page.
      if (done.status === 401) return window.location.assign(route('auth.login'));
      if (!done.ok) return fail(done);
      setPassword('');
      if (Array.isArray(done.data.recoveryCodes)) setCodes(done.data.recoveryCodes as string[]);
      else window.location.reload();
    } finally {
      setWorking(false);
    }
  }

  async function rename(id: number, newName: string) {
    const response = await fetch(route('auth.passkeys.update', { passkey: id }), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    if (response.ok) window.location.reload();
    else setError({ message: t('passkeys.register_failed'), sudo: response.status === 423 });
  }

  async function release(id: number, confirmation: string) {
    const done = await postJson(route('auth.passkeys.release', { passkey: id }), { password: confirmation });
    if (done.ok) window.location.reload();
    else fail(done, { form: 'release', id });
  }

  async function remove(id: number, confirmation: string) {
    const done = await postJson(route('auth.passkeys.destroy', { passkey: id }), { password: confirmation });
    if (done.ok) window.location.reload();
    else fail(done, { form: 'remove', id });
  }

  if (codes) {
    return (
      <main>
        <Head title={t('passkeys.codes_heading')} />
        <h1>{t('passkeys.codes_heading')}</h1>
        <p>
          <strong>{t('passkeys.codes_intro')}</strong>
        </p>
        <ul>
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <p>{t('two_factor.devices_signed_out')}</p>
        <p>
          <button type="button" onClick={() => window.location.reload()}>
            {t('passkeys.done')}
          </button>
        </p>
      </main>
    );
  }

  return (
    <main>
      <Head title={t('passkeys.title')} />
      <h1>{t('passkeys.title')}</h1>
      {!verified && (
        <div className="card cluster">
          <p>{t('verify.needed_for_factors')}</p>
          <Link route="auth.verification.send" className="button">
            {t('verify.resend')}
          </Link>
        </div>
      )}
      <p>{t('passkeys.intro')}</p>
      {error?.sudo && (
        <p role="alert">
          <Link route="auth.password.confirm">{t('passkeys.confirm_again')}</Link>
        </p>
      )}

      {passkeys.length === 0 ? (
        <p>{t('passkeys.none')}</p>
      ) : (
        <ul>
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <strong>{passkey.name}</strong>
              {passkey.suspended && (
                <>
                  <br />
                  <small role="status">{t('passkeys.suspended')}</small>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void release(passkey.id, releasing?.id === passkey.id ? releasing.password : '');
                    }}
                  >
                    <label htmlFor={`release-password-${passkey.id}`}>{t('passkeys.release_password')}</label>{' '}
                    <input
                      id={`release-password-${passkey.id}`}
                      type="password"
                      autoComplete="current-password"
                      value={releasing?.id === passkey.id ? releasing.password : ''}
                      onChange={(e) => setReleasing({ id: passkey.id, password: e.target.value })}
                      aria-invalid={error?.target?.form === 'release' && error.target.id === passkey.id}
                    />{' '}
                    <button type="submit">{t('passkeys.release')}</button>
                    {error?.target?.form === 'release' && error.target.id === passkey.id && <small role="alert"> {error.message}</small>}
                  </form>
                </>
              )}
              {passkey.synced && ` · ${t('passkeys.synced')}`} · {t('passkeys.created', { at: `${at(passkey.createdAt)} UTC` })} ·{' '}
              {passkey.lastUsedAt ? t('passkeys.last_used', { at: `${at(passkey.lastUsedAt)} UTC` }) : t('passkeys.never_used')}{' '}
              {renaming?.id === passkey.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rename(passkey.id, renaming.name);
                  }}
                >
                  <input aria-label={t('passkeys.name')} value={renaming.name} maxLength={100} onChange={(e) => setRenaming({ id: passkey.id, name: e.target.value })} />{' '}
                  <button type="submit">{t('passkeys.save')}</button>
                </form>
              ) : (
                <button type="button" onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}>
                  {t('passkeys.rename')}
                </button>
              )}{' '}
              {removing?.id === passkey.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void remove(passkey.id, removing.password);
                  }}
                >
                  <p>
                    {(lastFactor || passkey.suspended) && (
                      <>
                        <small>{lastFactor ? t('passkeys.last_factor_note') : t('passkeys.suspended_remove_note')}</small>
                        <br />
                      </>
                    )}
                    <label htmlFor={`remove-password-${passkey.id}`}>{passkey.suspended && !lastFactor ? t('passkeys.suspended_remove_password') : t('passkeys.remove_password')}</label>{' '}
                    <input
                      id={`remove-password-${passkey.id}`}
                      type="password"
                      autoComplete="current-password"
                      value={removing.password}
                      onChange={(e) => setRemoving({ id: passkey.id, password: e.target.value })}
                      aria-invalid={error?.target?.form === 'remove' && error.target.id === passkey.id}
                    />
                  </p>
                  <button type="submit">{t('passkeys.remove')}</button>
                  {error?.target?.form === 'remove' && error.target.id === passkey.id && <small role="alert"> {error.message}</small>}
                </form>
              ) : (
                <button type="button" onClick={() => setRemoving({ id: passkey.id, password: '' })}>
                  {t('passkeys.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {verified && (
        <section aria-labelledby="add-heading">
          <h2 id="add-heading">{t('passkeys.add_heading')}</h2>
          {!supported ? (
            <p>{t('passkeys.unsupported')}</p>
          ) : (
            <form
              method="post"
              action={route('auth.passkeys.store')}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              {firstFactor && (
                <p role="note">
                  <small>{t('passkeys.add_notice')}</small>
                </p>
              )}
              <p>
                <label htmlFor="passkey-name">{t('passkeys.name')}</label>
                <br />
                <input id="passkey-name" name="name" type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </p>
              <p>
                <label htmlFor="passkey-password">{t('passkeys.password')}</label>
                <br />
                <input
                  id="passkey-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error?.field === 'password' && !error.target}
                />
                {error?.field === 'password' && !error.target && <small role="alert"> {error.message}</small>}
              </p>
              {error && error.field !== 'password' && !error.target && <p role="alert">{error.message}</p>}
              <button type="submit" disabled={working || password === ''}>
                {working ? t('passkeys.working') : t('passkeys.add')}
              </button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}

Passkeys.layout = [AppLayout, SettingsLayout];

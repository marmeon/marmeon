import { useEffect, useState } from 'react';
import type { PageProps } from '@marmeon/http';
import { Head, useRoute, useTranslation } from '@marmeon/react';
import type { ShowPasskeysController } from '../controllers/ShowPasskeysController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';
import { createPasskey, passkeysAvailable, postJson } from '../passkeys.ts';

type Props = PageProps<ShowPasskeysController>;

/** What went wrong, and where it is shown: `target` names the form of a row, without one the message sits with the form that adds a passkey. */
type Problem = { field?: string; message: string; sudo?: boolean; target?: { form: 'release' | 'remove'; id: number } };

// The page works with JavaScript only: a passkey is made by the browser's API, and every answer is JSON. The forms still say they post, so a
// field that holds a password never goes into an address when the script is not there.
export default function Passkeys({ passkeys, lastFactor, firstFactor }: Props) {
  const t = useTranslation('auth');
  const route = useRoute();
  const [supported, setSupported] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Problem | null>(null);
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
  const fail = (result: { status: number; data: Record<string, any> }, target?: Problem['target']) =>
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
        // Cancelled, or this authenticator already holds a passkey for the account (`InvalidStateError`): the browser says nothing more.
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
      <main className="stack stack-loose">
        <Head title={t('passkeys.codes_heading')} />
        <h1>{t('passkeys.codes_heading')}</h1>
        <section aria-labelledby="codes-heading" className="card" data-kind="success">
          <h2 id="codes-heading">{t('passkeys.codes_heading')}</h2>
          <p>
            <strong>{t('passkeys.codes_intro')}</strong>
          </p>
          <ul className="auth-codes">
            {codes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <p>{t('two_factor.devices_signed_out')}</p>
          <button type="button" className="button" autoFocus onClick={() => window.location.reload()}>
            {t('passkeys.done')}
          </button>
        </section>
      </main>
    );
  }

  const problemOf = (form: 'release' | 'remove', id: number) => (error?.target?.form === form && error.target.id === id ? error : null);

  return (
    <main className="stack stack-loose">
      <Head title={t('passkeys.title')} />
      <h1>{t('passkeys.title')}</h1>
      <p>{t('passkeys.intro')}</p>
      {error?.sudo && (
        <div role="alert" className="notice" data-kind="error">
          {/* The page itself asks for the password again (its route is behind sudo mode) and comes back here. */}
          <button type="button" className="button-secondary" data-size="small" onClick={() => window.location.reload()}>
            {t('passkeys.confirm_again')}
          </button>
        </div>
      )}

      <section aria-labelledby="list-heading" className="card">
        <h2 id="list-heading">{t('passkeys.list_heading')}</h2>
        {passkeys.length === 0 ? (
          <p className="muted">{t('passkeys.none')}</p>
        ) : (
          <ul className="auth-passkeys">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="auth-passkey">
                <p className="auth-passkey-name">
                  <strong>{passkey.name}</strong>
                  {passkey.synced && <span className="badge">{t('passkeys.synced')}</span>}
                </p>
                <p className="hint">
                  {t('passkeys.created', { at: `${at(passkey.createdAt)} UTC` })} · {passkey.lastUsedAt ? t('passkeys.last_used', { at: `${at(passkey.lastUsedAt)} UTC` }) : t('passkeys.never_used')}
                </p>
                {passkey.suspended && (
                  <>
                    <p role="status" className="notice" data-kind="error">
                      {t('passkeys.suspended')}
                    </p>
                    <form
                      method="post"
                      action={route('auth.passkeys.release', { passkey: passkey.id })}
                      className="auth-passkey-form"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void release(passkey.id, releasing?.id === passkey.id ? releasing.password : '');
                      }}
                    >
                      <div className="field">
                        <label htmlFor={`release-password-${passkey.id}`}>{t('passkeys.release_password')}</label>
                        <input
                          id={`release-password-${passkey.id}`}
                          name="password"
                          type="password"
                          autoComplete="current-password"
                          value={releasing?.id === passkey.id ? releasing.password : ''}
                          onChange={(e) => setReleasing({ id: passkey.id, password: e.target.value })}
                          aria-invalid={problemOf('release', passkey.id) !== null}
                        />
                        {problemOf('release', passkey.id) && <small role="alert"> {problemOf('release', passkey.id)!.message}</small>}
                      </div>
                      <button type="submit" className="button" data-size="small">
                        {t('passkeys.release')}
                      </button>
                    </form>
                  </>
                )}
                <div className="auth-passkey-actions">
                  {renaming?.id === passkey.id ? (
                    <form
                      className="auth-passkey-form"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(passkey.id, renaming.name);
                      }}
                    >
                      <input aria-label={t('passkeys.name')} value={renaming.name} maxLength={100} autoFocus onChange={(e) => setRenaming({ id: passkey.id, name: e.target.value })} />
                      <button type="submit" className="button" data-size="small">
                        {t('passkeys.save')}
                      </button>
                    </form>
                  ) : (
                    <button type="button" className="button-secondary" data-size="small" onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}>
                      {t('passkeys.rename')}
                    </button>
                  )}
                  {removing?.id === passkey.id ? (
                    <form
                      method="post"
                      action={route('auth.passkeys.destroy', { passkey: passkey.id })}
                      className="auth-passkey-form"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        void remove(passkey.id, removing.password);
                      }}
                    >
                      {(lastFactor || passkey.suspended) && (
                        <div className="field">
                          <p className="hint">{lastFactor ? t('passkeys.last_factor_note') : t('passkeys.suspended_remove_note')}</p>
                          <label htmlFor={`remove-password-${passkey.id}`}>{lastFactor ? t('passkeys.remove_password') : t('passkeys.suspended_remove_password')}</label>
                          <input
                            id={`remove-password-${passkey.id}`}
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            autoFocus
                            value={removing.password}
                            onChange={(e) => setRemoving({ id: passkey.id, password: e.target.value })}
                            aria-invalid={problemOf('remove', passkey.id) !== null}
                          />
                        </div>
                      )}
                      <button type="submit" className="button-secondary" data-destructive="" data-size="small">
                        {t('passkeys.remove')}
                      </button>
                      {problemOf('remove', passkey.id) && <small role="alert"> {problemOf('remove', passkey.id)!.message}</small>}
                    </form>
                  ) : (
                    <button type="button" className="button-secondary" data-destructive="" data-size="small" onClick={() => setRemoving({ id: passkey.id, password: '' })}>
                      {t('passkeys.remove')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="add-heading" className="card">
        <h2 id="add-heading">{t('passkeys.add_heading')}</h2>
        {!supported ? (
          <p className="muted">{t('passkeys.unsupported')}</p>
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
              <p role="note" className="hint">
                {t('passkeys.add_notice')}
              </p>
            )}
            <div className="field">
              <label htmlFor="passkey-name">{t('passkeys.name')}</label>
              <input id="passkey-name" name="name" type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="passkey-password">{t('passkeys.password')}</label>
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
            </div>
            {error && error.field !== 'password' && !error.target && <p role="alert">{error.message}</p>}
            <button type="submit" className="button" disabled={working || password === ''}>
              {working ? t('passkeys.working') : t('passkeys.add')}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

Passkeys.layout = [AppLayout, SettingsLayout];

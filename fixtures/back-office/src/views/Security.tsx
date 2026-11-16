import { useEffect, useState } from 'react';
import { createPasskey, passkeysAvailable, postJson } from '@marmeon/auth/passkeys/browser';
import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ConfirmOfficeTwoFactorController } from '../ConfirmOfficeTwoFactorController.ts';
import type { DisableOfficeTwoFactorController } from '../DisableOfficeTwoFactorController.ts';
import type { RegenerateOfficeRecoveryCodesController } from '../RegenerateOfficeRecoveryCodesController.ts';
import type { ShowOfficeSecurityController } from '../ShowOfficeSecurityController.ts';

type Props = PageProps<ShowOfficeSecurityController>;

/** The editor's second factors: the authenticator app, the recovery codes and the passkeys. Passkeys are made by the browser's API, so that part works with JavaScript only. */
export default function Security({ enabled, secured, setup, recoveryCodesLeft, passkeys, lastFactor }: Props) {
  const route = useRoute();
  const t = useTranslation('office');
  const confirmForm = useForm<ConfirmOfficeTwoFactorController>({ code: '', password: '' });
  const disableForm = useForm<DisableOfficeTwoFactorController>({ password: '' });
  const codesForm = useForm<RegenerateOfficeRecoveryCodesController>({ password: '' });
  const [supported, setSupported] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [removing, setRemoving] = useState<{ id: number; password: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The recovery codes of a first passkey are in this answer only: kept in this component's memory, gone when it closes.
  const [codes, setCodes] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  // In UTC: the server and the browser render the same text.
  const at = (iso: string | Date) => `${t.format.date(iso, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

  useEffect(() => setSupported(passkeysAvailable()), []);

  async function add() {
    setWorking(true);
    setProblem(null);
    try {
      const options = await postJson(route('office.passkeys.options'));
      if (!options.ok) return setProblem(typeof options.data.error === 'string' ? options.data.error : t('passkeys.registerFailed'));
      let credential;
      try {
        credential = await createPasskey(options.data);
      } catch {
        // Cancelled, or this authenticator already holds a passkey for the editor: the browser says nothing more.
        return setProblem(t('passkeys.cancelled'));
      }
      const done = await postJson(route('office.passkeys.store'), { response: credential, name: name.trim() || t('security.passkeyNameDefault'), password });
      if (done.status === 401) return window.location.assign(route('office.login'));
      if (!done.ok) return setProblem(typeof done.data.error === 'string' ? done.data.error : t('passkeys.registerFailed'));
      setPassword('');
      if (Array.isArray(done.data.recoveryCodes)) setCodes(done.data.recoveryCodes as string[]);
      else window.location.reload();
    } finally {
      setWorking(false);
    }
  }

  async function remove(id: number, confirmation: string) {
    const done = await postJson(route('office.passkeys.destroy', { passkey: id }), { password: confirmation });
    if (done.ok) window.location.reload();
    else setProblem(typeof done.data.error === 'string' ? done.data.error : t('passkeys.registerFailed'));
  }

  if (codes) {
    return (
      <main data-area="office">
        <Head title={t('codes.title')} />
        <h1>{t('codes.title')}</h1>
        <p>
          <strong>{t('codes.intro')}</strong>
        </p>
        <ul>
          {codes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <p>{t('codes.signedOut')}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {t('codes.done')}
        </button>
      </main>
    );
  }

  return (
    <main data-area="office">
      <Head title={t('security.title')} />
      <h1>{t('security.title')}</h1>
      <p>{t('security.intro')}</p>

      <section aria-labelledby="authenticator-heading">
        <h2 id="authenticator-heading">{t('security.authenticator')}</h2>
        {!enabled && !setup && (
          <Link route="office.two-factor.begin">
            {t('security.enable')}
          </Link>
        )}
        {setup && (
          <>
            <p>{t('security.scan')}</p>
            {/* The QR code is one path of a server-made SVG: no innerHTML, no style attribute. It sits on white, which some apps need to scan it. */}
            <svg viewBox={`-2 -2 ${setup.qr.size + 4} ${setup.qr.size + 4}`} width="192" height="192" role="img" aria-label={t('security.qrLabel')} shapeRendering="crispEdges">
              <rect x="-2" y="-2" width={setup.qr.size + 4} height={setup.qr.size + 4} fill="#fff" />
              <path d={setup.qr.path} fill="#000" />
            </svg>
            <p>
              {t('security.key')} <code>{setup.secret}</code>
            </p>
            <form
              method="post"
              action={route('office.two-factor.confirm')}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void confirmForm.post(route('office.two-factor.confirm'), { onFinish: () => confirmForm.reset() });
              }}
            >
              <p>
                <label htmlFor="confirm-code">{t('security.confirmCode')}</label>
                <br />
                <input id="confirm-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" value={confirmForm.data.code} onChange={(e) => confirmForm.set('code', e.target.value)} aria-invalid={!!confirmForm.errors.code} />
                {confirmForm.errors.code && <small role="alert"> {confirmForm.errors.code}</small>}
              </p>
              <p>
                <label htmlFor="confirm-password">{t('security.password')}</label>
                <br />
                <input id="confirm-password" name="password" type="password" autoComplete="current-password" value={confirmForm.data.password} onChange={(e) => confirmForm.set('password', e.target.value)} aria-invalid={!!confirmForm.errors.password} />
                {confirmForm.errors.password && <small role="alert"> {confirmForm.errors.password}</small>}
              </p>
              <button type="submit" disabled={confirmForm.processing}>
                {t('security.confirmSubmit')}
              </button>
            </form>
          </>
        )}
        {enabled && (
          <form
            method="post"
            action={route('office.two-factor.disable')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void disableForm.post(route('office.two-factor.disable'), { onFinish: () => disableForm.reset() });
            }}
          >
            <p>{t('security.on')}</p>
            <p>
              <label htmlFor="disable-password">{t('security.password')}</label>
              <br />
              <input id="disable-password" name="password" type="password" autoComplete="current-password" value={disableForm.data.password} onChange={(e) => disableForm.set('password', e.target.value)} aria-invalid={!!disableForm.errors.password} />
              {disableForm.errors.password && <small role="alert"> {disableForm.errors.password}</small>}
            </p>
            <button type="submit" disabled={disableForm.processing}>
              {t('security.disable')}
            </button>
          </form>
        )}
      </section>

      {secured && (
        <section aria-labelledby="codes-heading">
          <h2 id="codes-heading">{t('codes.title')}</h2>
          {!enabled && <p>{t('security.passkeysOnly')}</p>}
          <p>{t('security.recoveryLeft', { count: recoveryCodesLeft })}</p>
          <form
            method="post"
            action={route('office.two-factor.codes')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void codesForm.post(route('office.two-factor.codes'), { onFinish: () => codesForm.reset() });
            }}
          >
            <p>
              <label htmlFor="codes-password">{t('security.password')}</label>
              <br />
              <input id="codes-password" name="password" type="password" autoComplete="current-password" value={codesForm.data.password} onChange={(e) => codesForm.set('password', e.target.value)} aria-invalid={!!codesForm.errors.password} />
              {codesForm.errors.password && <small role="alert"> {codesForm.errors.password}</small>}
            </p>
            <button type="submit" disabled={codesForm.processing}>
              {t('security.regenerate')}
            </button>
          </form>
        </section>
      )}

      <section aria-labelledby="passkeys-heading">
        <h2 id="passkeys-heading">{t('security.passkeys')}</h2>
        <p>{t('security.passkeysIntro')}</p>
        {passkeys.length === 0 ? (
          <p>{t('security.noPasskeys')}</p>
        ) : (
          <ul>
            {passkeys.map((passkey) => (
              <li key={passkey.id}>
                <strong>{passkey.name}</strong>
                <br />
                <small>
                  {t('security.created', { at: at(passkey.createdAt) })} · {passkey.lastUsedAt ? t('security.lastUsed', { at: at(passkey.lastUsedAt) }) : t('security.never')}
                </small>
                {passkey.suspended && <p role="status">{t('security.suspended')}</p>}
                {removing?.id === passkey.id ? (
                  <form
                    method="post"
                    action={route('office.passkeys.destroy', { passkey: passkey.id })}
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      void remove(passkey.id, removing.password);
                    }}
                  >
                    {lastFactor && <p>{t('security.lastFactorNote')}</p>}
                    <label htmlFor={`remove-${passkey.id}`}>{t('security.password')}</label>
                    <br />
                    <input id={`remove-${passkey.id}`} name="password" type="password" autoComplete="current-password" value={removing.password} onChange={(e) => setRemoving({ id: passkey.id, password: e.target.value })} />
                    <button type="submit">{t('security.removePasskey')}</button>
                  </form>
                ) : (
                  <button type="button" onClick={() => setRemoving({ id: passkey.id, password: '' })}>
                    {t('security.removePasskey')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {problem && <p role="alert">{problem}</p>}
        {!supported ? (
          <p>{t('security.unsupported')}</p>
        ) : (
          <form
            method="post"
            action={route('office.passkeys.store')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <p>
              <label htmlFor="passkey-name">{t('security.passkeyName')}</label>
              <br />
              <input id="passkey-name" name="name" type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </p>
            <p>
              <label htmlFor="passkey-password">{t('security.password')}</label>
              <br />
              <input id="passkey-password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </p>
            <button type="submit" disabled={working || password === ''}>
              {working ? t('security.working') : t('security.addPasskey')}
            </button>
          </form>
        )}
      </section>
      <p>
        <Link route="office.index">{t('security.back')}</Link>
      </p>
    </main>
  );
}

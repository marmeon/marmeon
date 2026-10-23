import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, useForm, useTranslation } from '@marmeon/react';
import type { ShowSecurityController } from '../controllers/ShowSecurityController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowSecurityController>;

export default function Security({ viaRemember, email, emailChangeWaits, pendingEmail, signIns, auth }: Props) {
  const t = useTranslation('auth');
  // Leaving with a changed address or typed passwords asks first (the navigation guard); the address — never a password —
  // is still there after Back/Forward (remembered in memory).
  const emailForm = useForm('auth.email.update', { email, current_password: '' }, { guard: t('security.unsaved'), remember: true });
  const passwordForm = useForm('auth.password.update', { current_password: '', password: '', password_confirmation: '' }, { guard: t('security.unsaved') });
  const devicesForm = useForm('auth.devices.logout', { password: '' });

  return (
    <main className="stack stack-loose">
      <Head title={t('security.title')} />
      <h1>{t('security.title')}</h1>
      {viaRemember && (
        <p className="hint">{t('security.remembered', { name: auth?.user?.name ?? '' })}</p>
      )}

      <section aria-labelledby="email-heading" className="card">
        <h2 id="email-heading">{t('security.email_heading')}</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // Private registration: the address stays the current one until the link is clicked — the field shows it again
            // (the request waits below). Otherwise the new address is the account's: it stays in the field.
            void emailForm.submit({ onSuccess: () => (emailChangeWaits ? emailForm.reset() : undefined), onFinish: () => emailForm.set('current_password', '') });
          }}
        >
          <div className="field">
            <label htmlFor="email">{t('security.email')}</label>
            <input id="email" type="email" autoComplete="email" value={emailForm.data.email} onChange={(e) => emailForm.set('email', e.target.value)} aria-invalid={!!emailForm.errors.email} />
            {emailForm.errors.email && <small role="alert"> {emailForm.errors.email}</small>}
            {auth?.user && !auth.user.verified && <small> {t('security.unconfirmed')}</small>}
          </div>
          <div className="field">
            <label htmlFor="email-current-password">{t('security.current_password')}</label>
            <input
              id="email-current-password"
              type="password"
              autoComplete="current-password"
              value={emailForm.data.current_password}
              onChange={(e) => emailForm.set('current_password', e.target.value)}
              aria-invalid={!!emailForm.errors.current_password}
            />
            {emailForm.errors.current_password && <small role="alert"> {emailForm.errors.current_password}</small>}
          </div>
          {pendingEmail && (
            <p role="status" className="notice">
              <small>{t('security.email_pending', { email: pendingEmail, current: email })}</small>
            </p>
          )}
          <button type="submit" className="button" disabled={emailForm.processing || !emailForm.isDirty()}>
            {t('security.change_email')}
          </button>
        </form>
      </section>

      <section aria-labelledby="password-heading" className="card">
        <h2 id="password-heading">{t('security.password_heading')}</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void passwordForm.submit({ onFinish: () => passwordForm.reset() });
          }}
        >
          {(
            [
              ['current_password', t('security.current_password'), 'current-password'],
              ['password', t('security.new_password', { min: 8 }), 'new-password'],
              ['password_confirmation', t('security.repeat_password'), 'new-password'],
            ] as const
          ).map(([name, label, autoComplete]) => (
            <div className="field" key={name}>
              <label htmlFor={name}>{label}</label>
              <input
                id={name}
                type="password"
                autoComplete={autoComplete}
                value={passwordForm.data[name]}
                onChange={(e) => passwordForm.set(name, e.target.value)}
                aria-invalid={!!passwordForm.errors[name]}
              />
              {passwordForm.errors[name] && <small role="alert"> {passwordForm.errors[name]}</small>}
            </div>
          ))}
          <button type="submit" className="button" disabled={passwordForm.processing}>
            {t('security.change_password')}
          </button>
        </form>
        <ApiTokensNote />
      </section>

      {signIns && (
        <section aria-labelledby="sign-ins-heading" className="card">
          <h2 id="sign-ins-heading">{t('security.sign_ins_heading')}</h2>
          <p>{t('security.sign_ins_intro')}</p>
          <ul className="auth-passkeys">
            {signIns.map((signIn) => {
              const { browser, system } = signIn.device;
              return (
                <li key={signIn.id} className="auth-passkey">
                  <p className="auth-passkey-name">
                    <strong>
                      {t('security.sign_ins_device', {
                        browser: browser ?? t('security.sign_ins_unknown_browser'),
                        system: system ?? t('security.sign_ins_unknown_system'),
                      })}
                    </strong>
                    {signIn.current && <span className="badge">{t('security.sign_ins_current')}</span>}
                    {signIn.remembered && <span className="badge">{t('security.sign_ins_remembered')}</span>}
                  </p>
                  <p className="hint">
                    {t('security.sign_ins_last_active', { at: `${t.format.date(signIn.lastSeenAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` })}
                  </p>
                  {/* This browser's own sign-in is ended by Sign out. */}
                  {!signIn.current && (
                    <Form route="auth.sign-ins.destroy" params={{ signIn: signIn.id }} className="auth-passkey-actions">
                      <button type="submit" className="button-secondary" data-size="small">
                        {t('security.sign_ins_end')}
                      </button>
                    </Form>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="devices-heading" className="card">
        <h2 id="devices-heading">{t('security.devices_heading')}</h2>
        <p>{t('security.devices_intro')}</p>
        <ApiTokensNote />
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void devicesForm.submit({ onFinish: () => devicesForm.reset() });
          }}
        >
          <div className="field">
            <label htmlFor="devices-password">{t('security.devices_password')}</label>
            <input
              id="devices-password"
              type="password"
              autoComplete="current-password"
              value={devicesForm.data.password}
              onChange={(e) => devicesForm.set('password', e.target.value)}
              aria-invalid={!!devicesForm.errors.password}
            />
            {devicesForm.errors.password && <small role="alert"> {devicesForm.errors.password}</small>}
          </div>
          <button type="submit" className="button-secondary" disabled={devicesForm.processing}>
            {t('security.devices_submit')}
          </button>
        </form>
      </section>
    </main>
  );
}

Security.layout = [AppLayout, SettingsLayout];

/** Passwords and sessions are one thing, API tokens another: revoking them is done by hand. */
function ApiTokensNote() {
  const t = useTranslation('auth');
  return (
    <p role="note" className="hint">
      {t('security.tokens_note')} <Link route="auth.tokens">{t('settings.tokens')}</Link>.
    </p>
  );
}

import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowSecurityController } from '../controllers/ShowSecurityController.ts';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowSecurityController>;

export default function Security({ viaRemember, email, emailChangeWaits, pendingEmail, auth }: Props) {
  const t = useTranslation('auth');
  const route = useRoute();
  // Leaving with a changed address or typed passwords asks first (the navigation guard); the address — never a password —
  // is still there after Back/Forward (remembered in memory).
  const emailForm = useForm('auth.email.update', {}, { email }, { guard: t('security.unsaved'), remember: true });
  const passwordForm = useForm('auth.password.update', {}, { current_password: '', password: '', password_confirmation: '' }, { guard: t('security.unsaved') });
  const devicesForm = useForm('auth.devices.logout', { password: '' });

  return (
    <main>
      <Head title={t('security.title')} />
      <h1>{t('security.title')}</h1>
      {viaRemember && (
        <p>
          <small>{t('security.remembered', { name: auth?.user?.name ?? '' })}</small>
        </p>
      )}

      <section aria-labelledby="email-heading">
        <h2 id="email-heading">{t('security.email_heading')}</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // Private registration: the address stays the current one until the link is clicked — the field shows it again
            // (the request waits below). Otherwise the new address is the account's: it stays in the field.
            void emailForm.submit({ onSuccess: () => (emailChangeWaits ? emailForm.reset() : undefined) });
          }}
        >
          <p>
            <label htmlFor="email">{t('security.email')}</label>
            <br />
            <input id="email" type="email" autoComplete="email" value={emailForm.data.email} onChange={(e) => emailForm.set('email', e.target.value)} aria-invalid={!!emailForm.errors.email} />
            {emailForm.errors.email && <small role="alert"> {emailForm.errors.email}</small>}
            {auth?.user && !auth.user.verified && <small> {t('security.unconfirmed')}</small>}
          </p>
          {pendingEmail && (
            <p role="status">
              <small>{t('security.email_pending', { email: pendingEmail, current: email })}</small>
            </p>
          )}
          <button type="submit" disabled={emailForm.processing || !emailForm.isDirty()}>
            {t('security.change_email')}
          </button>
        </form>
      </section>

      <section aria-labelledby="password-heading">
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
            <p key={name}>
              <label htmlFor={name}>{label}</label>
              <br />
              <input
                id={name}
                type="password"
                autoComplete={autoComplete}
                value={passwordForm.data[name]}
                onChange={(e) => passwordForm.set(name, e.target.value)}
                aria-invalid={!!passwordForm.errors[name]}
              />
              {passwordForm.errors[name] && <small role="alert"> {passwordForm.errors[name]}</small>}
            </p>
          ))}
          <button type="submit" disabled={passwordForm.processing}>
            {t('security.change_password')}
          </button>
        </form>
        <ApiTokensNote />
      </section>

      <section aria-labelledby="devices-heading">
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
          <p>
            <label htmlFor="devices-password">{t('security.devices_password')}</label>
            <br />
            <input
              id="devices-password"
              type="password"
              autoComplete="current-password"
              value={devicesForm.data.password}
              onChange={(e) => devicesForm.set('password', e.target.value)}
              aria-invalid={!!devicesForm.errors.password}
            />
            {devicesForm.errors.password && <small role="alert"> {devicesForm.errors.password}</small>}
          </p>
          <button type="submit" disabled={devicesForm.processing}>
            {t('security.devices_submit')}
          </button>
        </form>
      </section>

      <section aria-labelledby="export-heading">
        <h2 id="export-heading">{t('security.export_heading')}</h2>
        <p>{t('security.export_intro')}</p>
        {/* A plain form on purpose: the answer is a redirect to a download (a signed, five-minute URL), not a page. */}
        <form method="post" action={route('user-profile.export')}>
          <button type="submit">{t('security.export_submit')}</button>
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
    <p role="note">
      <small>
        {t('security.tokens_note')} <Link route="auth.tokens">{t('settings.tokens')}</Link>.
      </small>
    </p>
  );
}

import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useTranslation } from '@marmeon/react';
import { AppLayout } from '../../../layouts/AppLayout.tsx';
import type { ShowTwoFactorController } from '../controllers/ShowTwoFactorController.ts';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowTwoFactorController>;

export default function TwoFactor({ enabled, setup, recoveryCodesLeft }: Props) {
  const t = useTranslation('auth');
  const confirmForm = useForm('auth.two-factor.confirm', { code: '' });
  const disableForm = useForm('auth.two-factor.disable', { password: '' });

  return (
    <main>
      <Head title={t('two_factor.title')} />
      <h1>{t('two_factor.title')}</h1>
      <p>{t('two_factor.intro')}</p>

      {!enabled && !setup && (
        <Link route="auth.two-factor.begin">{t('two_factor.enable')}</Link>
      )}

      {setup && (
        <section aria-labelledby="setup-heading">
          <h2 id="setup-heading">{t('two_factor.setup_heading')}</h2>
          <p>{t('two_factor.scan')}</p>
          {/* The QR code is one path of a server-made SVG — no innerHTML, no style attribute. */}
          <svg viewBox={`-2 -2 ${setup.qr.size + 4} ${setup.qr.size + 4}`} width="192" height="192" role="img" aria-label={t('two_factor.qr_label')} shapeRendering="crispEdges">
            <rect x="-2" y="-2" width={setup.qr.size + 4} height={setup.qr.size + 4} fill="#fff" />
            <path d={setup.qr.path} fill="#000" />
          </svg>
          <p>
            {t('two_factor.key')} <code>{setup.secret}</code>
          </p>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void confirmForm.submit({ onFinish: () => confirmForm.reset() });
            }}
          >
            <p>
              <label htmlFor="confirm-code">{t('two_factor.confirm_code')}</label>
              <br />
              <input
                id="confirm-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={confirmForm.data.code}
                onChange={(e) => confirmForm.set('code', e.target.value)}
                aria-invalid={!!confirmForm.errors.code}
              />
              {confirmForm.errors.code && <small role="alert"> {confirmForm.errors.code}</small>}
            </p>
            <button type="submit" disabled={confirmForm.processing}>
              {t('two_factor.confirm_submit')}
            </button>
          </form>
        </section>
      )}

      {enabled && (
        <>
          <section aria-labelledby="status-heading">
            <h2 id="status-heading">{t('two_factor.on_heading')}</h2>
            <p>{t('two_factor.recovery_left', { count: recoveryCodesLeft })}</p>
            {recoveryCodesLeft <= 3 && (
              <p role="status">
                <small>{t('two_factor.recovery_low')}</small>
              </p>
            )}
            <p>
              <Link route="auth.two-factor.codes">{t('two_factor.regenerate')}</Link>
            </p>
            <p role="note">
              <small>
                {t('two_factor.devices_note')} <Link route="auth.security">{t('settings.security')}</Link>.
              </small>
            </p>
          </section>

          <section aria-labelledby="disable-heading">
            <h2 id="disable-heading">{t('two_factor.disable_heading')}</h2>
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void disableForm.submit({ onFinish: () => disableForm.reset() });
              }}
            >
              <p>
                <label htmlFor="disable-password">{t('two_factor.disable_password')}</label>
                <br />
                <input
                  id="disable-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={disableForm.data.password}
                  onChange={(e) => disableForm.set('password', e.target.value)}
                  aria-invalid={!!disableForm.errors.password}
                />
                {disableForm.errors.password && <small role="alert"> {disableForm.errors.password}</small>}
              </p>
              <button type="submit" disabled={disableForm.processing}>
                {t('two_factor.disable_submit')}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}

TwoFactor.layout = [AppLayout, SettingsLayout];

import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ShowTwoFactorController } from '../controllers/ShowTwoFactorController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { SettingsLayout } from '../layouts/SettingsLayout.tsx';

type Props = PageProps<ShowTwoFactorController>;

export default function TwoFactor({ enabled, setup, recoveryCodesLeft }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  const confirmForm = useForm('auth.two-factor.confirm', { code: '', password: '' });
  const disableForm = useForm('auth.two-factor.disable', { password: '' });

  return (
    <main className="stack stack-loose">
      <Head title={t('two_factor.title')} />
      <h1>{t('two_factor.title')}</h1>
      <p>{t('two_factor.intro')}</p>

      {!enabled && !setup && (
        <section aria-labelledby="enable-heading" className="card">
          <h2 id="enable-heading">{t('two_factor.setup_heading')}</h2>
          <Link route="auth.two-factor.begin" className="button">
            {t('two_factor.enable')}
          </Link>
        </section>
      )}

      {setup && (
        <section aria-labelledby="setup-heading" className="card">
          <h2 id="setup-heading">{t('two_factor.setup_heading')}</h2>
          <p>{t('two_factor.scan')}</p>
          {/* The QR code is one path of a server-made SVG — no innerHTML, no style attribute. It sits on white in the dark mode too: some apps do not scan it otherwise. */}
          <svg
            className="auth-qr"
            viewBox={`-2 -2 ${setup.qr.size + 4} ${setup.qr.size + 4}`}
            width="192"
            height="192"
            role="img"
            aria-label={t('two_factor.qr_label')}
            shapeRendering="crispEdges"
          >
            <rect x="-2" y="-2" width={setup.qr.size + 4} height={setup.qr.size + 4} fill="#fff" />
            <path d={setup.qr.path} fill="#000" />
          </svg>
          <p>
            {t('two_factor.key')} <code>{setup.secret}</code>
          </p>
          <form
            method="post"
            action={route('auth.two-factor.confirm')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void confirmForm.submit({ onFinish: () => confirmForm.reset() });
            }}
          >
            <p role="note" className="hint">
              {t('two_factor.confirm_notice')}
            </p>
            <div className="field">
              <label htmlFor="confirm-code">{t('two_factor.confirm_code')}</label>
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
            </div>
            <div className="field">
              <label htmlFor="confirm-password">{t('two_factor.disable_password')}</label>
              <input
                id="confirm-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={confirmForm.data.password}
                onChange={(e) => confirmForm.set('password', e.target.value)}
                aria-invalid={!!confirmForm.errors.password}
              />
              {confirmForm.errors.password && <small role="alert"> {confirmForm.errors.password}</small>}
            </div>
            <button type="submit" className="button" disabled={confirmForm.processing}>
              {t('two_factor.confirm_submit')}
            </button>
          </form>
        </section>
      )}

      {enabled && (
        <>
          <section aria-labelledby="status-heading" className="card">
            <h2 id="status-heading">{t('two_factor.on_heading')}</h2>
            <p>{t('two_factor.recovery_left', { count: recoveryCodesLeft })}</p>
            {recoveryCodesLeft <= 3 && (
              <p role="status" className="notice">
                {t('two_factor.recovery_low')}
              </p>
            )}
            <Link route="auth.two-factor.codes" className="button-secondary">
              {t('two_factor.regenerate')}
            </Link>
          </section>

          <section aria-labelledby="disable-heading" className="card">
            <h2 id="disable-heading">{t('two_factor.disable_heading')}</h2>
            <form
              method="post"
              action={route('auth.two-factor.disable')}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void disableForm.submit({ onFinish: () => disableForm.reset() });
              }}
            >
              <div className="field">
                <label htmlFor="disable-password">{t('two_factor.disable_password')}</label>
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
              </div>
              <button type="submit" className="button" data-destructive="" disabled={disableForm.processing}>
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

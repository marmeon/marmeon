import { useEffect, useRef, useState } from 'react';
import type { PageProps } from '@marmeon/http';
import { Head, Link, useForm, useRoute, useTranslation } from '@marmeon/react';
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';
import { conditionalAvailable, getPasskey, passkeysAvailable, postJson } from '../passkeys.ts';

type Props = PageProps<ShowLoginController>;

export default function Login({ appName, old, remember: rememberOffered }: Props) {
  const route = useRoute();
  const t = useTranslation('auth');
  // Method, URL, fields and errors come from the route (auth.login.store → LoginController's LoginRequest).
  // The password never comes back from the server.
  const form = useForm('auth.login.store', { email: old.email ?? '', password: '', remember: false });

  // Passkeys appear after hydration, and only where the browser has them: without JavaScript there is the password form alone.
  const [supported, setSupported] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const optionsInFlight = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(false);
  const remember = useRef(false);
  remember.current = rememberOffered && form.data.remember === true;

  // One ceremony at a time: the autofill's (conditional) wait ends when the button is pressed. The options request of the one that ends
  // is awaited first — the session holds a single challenge, and a late answer of the old request must not replace the new one's.
  async function signInWithPasskey(conditional: boolean) {
    waiting.current?.abort();
    await optionsInFlight.current?.catch(() => undefined);
    if (!mounted.current) return;
    const controller = new AbortController();
    waiting.current = controller;
    setPasskeyError(null);
    try {
      // Not aborted by the signal: the request is let finish, and the next ceremony waits for it (see above).
      const request = postJson(route('auth.passkeys.sign-in.options'));
      optionsInFlight.current = request;
      const options = await request;
      if (controller.signal.aborted) return;
      if (!options.ok) throw new Error('options');
      const response = await getPasskey(options.data, { conditional, signal: controller.signal });
      const done = await postJson(route('auth.passkeys.sign-in'), { response, remember: remember.current });
      // Signed in: the page is on its way elsewhere, and nothing starts again.
      if (done.ok) return;
      setPasskeyError(typeof done.data.error === 'string' ? done.data.error : t('passkeys.failed'));
    } catch {
      if (!controller.signal.aborted && !conditional) setPasskeyError(t('passkeys.cancelled'));
    }
    // After a pressed button that did not sign in, the autofill offers the passkeys again.
    if (!conditional && mounted.current) startConditional();
  }

  function startConditional() {
    void conditionalAvailable().then((available) => {
      if (available && mounted.current) void signInWithPasskey(true);
    });
  }

  useEffect(() => {
    mounted.current = true;
    if (passkeysAvailable()) {
      setSupported(true);
      startConditional();
    }
    return () => {
      // Also the cleanup of a StrictMode re-run: nothing starts after it, and the wait in the autofill ends.
      mounted.current = false;
      waiting.current?.abort();
    };
  }, []);

  return (
    <main className="app-main">
      <div className="card auth-card">
        <Head title={t('login.title')} />
        <h1>{t('login.heading', { app: appName })}</h1>
        {/* Works without JavaScript too: a plain form post — the browser's Fetch Metadata and Origin vouch for it. */}
        <form
          method="post"
          action={route('auth.login.store')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit({ onFinish: () => form.set('password', '') });
          }}
        >
          <div className="field">
            <label htmlFor="email">{t('login.email')}</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username webauthn"
              value={form.data.email}
              onChange={(e) => form.set('email', e.target.value)}
              aria-invalid={!!form.errors.email}
            />
            {form.errors.email && <small role="alert"> {form.errors.email}</small>}
          </div>
          <div className="field">
            <label htmlFor="password">{t('login.password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={form.data.password}
              onChange={(e) => form.set('password', e.target.value)}
              aria-invalid={!!form.errors.password}
            />
            {form.errors.password && <small role="alert"> {form.errors.password}</small>}
          </div>
          {rememberOffered && (
            <div className="field">
              <label className="choice">
                <input type="checkbox" name="remember" checked={form.data.remember === true} onChange={(e) => form.set('remember', e.target.checked)} /> {t('login.remember')}
              </label>
            </div>
          )}
          <button type="submit" className="button auth-submit" disabled={form.processing}>
            {form.processing ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
        {supported && (
          <div className="auth-alternative">
            <button type="button" className="button-secondary auth-submit" onClick={() => void signInWithPasskey(false)}>
              {t('passkeys.sign_in')}
            </button>
            {passkeyError && <small role="alert">{passkeyError}</small>}
          </div>
        )}
        <p className="cluster auth-card-footer">
          <Link route="auth.password.request">{t('login.forgot')}</Link>
          <span className="muted">
            {t('login.new_here')} <Link route="auth.register">{t('login.register')}</Link>
          </span>
        </p>
      </div>
    </main>
  );
}

Login.layout = AppLayout;

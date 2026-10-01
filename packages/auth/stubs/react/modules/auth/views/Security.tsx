import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { LogoutOtherDevicesController } from '../controllers/LogoutOtherDevicesController.ts';
import type { ShowSecurityController } from '../controllers/ShowSecurityController.ts';
import type { UpdateEmailController } from '../controllers/UpdateEmailController.ts';
import type { UpdatePasswordController } from '../controllers/UpdatePasswordController.ts';

type Props = PageProps<ShowSecurityController>;

export default function Security({ viaRemember, email, flash, auth }: Props) {
  const emailForm = useForm<UpdateEmailController>({ email });
  const passwordForm = useForm<UpdatePasswordController>({ current_password: '', password: '', password_confirmation: '' });
  const devicesForm = useForm<LogoutOtherDevicesController>({ password: '' });

  return (
    <main>
      <Head title="Security" />
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Security</h1>
      <p>
        <Link href="/settings/tokens">API tokens</Link>
      </p>
      {flash.status && <p role="status">{flash.status}</p>}
      {viaRemember && (
        <p>
          <small>{auth.user?.name}, you were signed in by “Keep me signed in” on this device.</small>
        </p>
      )}

      <section aria-labelledby="email-heading">
        <h2 id="email-heading">E-mail address</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void emailForm.put('/settings/email');
          }}
        >
          <p>
            <label htmlFor="email">E-mail</label>
            <br />
            <input id="email" type="email" autoComplete="email" value={emailForm.data.email} onChange={(e) => emailForm.set('email', e.target.value)} aria-invalid={!!emailForm.errors.email} />
            {emailForm.errors.email && <small role="alert"> {emailForm.errors.email}</small>}
            {auth.user && !auth.user.verified && <small> (not confirmed yet)</small>}
          </p>
          <button type="submit" disabled={emailForm.processing || !emailForm.isDirty}>
            Change e-mail
          </button>
        </form>
      </section>

      <section aria-labelledby="password-heading">
        <h2 id="password-heading">Change password</h2>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void passwordForm.put('/settings/password', { onFinish: () => passwordForm.reset() });
          }}
        >
          {(
            [
              ['current_password', 'Current password', 'current-password'],
              ['password', 'New password (at least 8 characters)', 'new-password'],
              ['password_confirmation', 'Repeat the new password', 'new-password'],
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
            Change password
          </button>
        </form>
      </section>

      <section aria-labelledby="devices-heading">
        <h2 id="devices-heading">Other devices</h2>
        <p>Signs you out everywhere else — other browsers, and “Keep me signed in” on other devices. This one stays signed in.</p>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void devicesForm.post('/settings/devices/logout', { onFinish: () => devicesForm.reset() });
          }}
        >
          <p>
            <label htmlFor="devices-password">Password</label>
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
            Sign out other devices
          </button>
        </form>
      </section>
    </main>
  );
}

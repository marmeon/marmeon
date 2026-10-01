import type { PageProps } from '@bespokecore/http';
import { Head, Link, useForm } from '@bespokecore/react';
import type { LogoutOtherDevicesController } from '../controllers/LogoutOtherDevicesController.ts';
import type { ShowSecurityController } from '../controllers/ShowSecurityController.ts';
import type { UpdatePasswordController } from '../controllers/UpdatePasswordController.ts';

type Props = PageProps<ShowSecurityController>;

export default function Security({ viaRemember, flash, auth }: Props) {
  const passwordForm = useForm<UpdatePasswordController>({ current_password: '', password: '', password_confirmation: '' });
  const devicesForm = useForm<LogoutOtherDevicesController>({ password: '' });

  return (
    <main>
      <Head title="Security" />
      <p>
        <Link href="/users/me">← Back to your profile</Link>
      </p>
      <h1>Security</h1>
      {flash.status && <p role="status">{flash.status}</p>}
      {viaRemember && (
        <p>
          <small>{auth.user?.name}, you were signed in by “Keep me signed in” on this device.</small>
        </p>
      )}

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

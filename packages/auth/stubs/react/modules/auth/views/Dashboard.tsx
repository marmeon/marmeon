import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';

type Props = PageProps<ShowDashboardController>;

export default function Dashboard({ name, verified, flash }: Props) {
  return (
    <main>
      <Head title="Dashboard" />
      <header>
        Signed in as {name}{' '}
        <Link route="auth.logout">
          Sign out
        </Link>
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      <h1>Dashboard</h1>
      {!verified && (
        <p role="note">
          Please confirm your e-mail address — the link is in your inbox.{' '}
          <Link route="auth.verification.send">
            Send it again
          </Link>
        </p>
      )}
      <p>
        <Link route="auth.security">Security</Link> · <Link route="auth.tokens">API tokens</Link>
      </p>
    </main>
  );
}

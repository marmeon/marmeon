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
        <Link method="post" href="/logout">
          Sign out
        </Link>
      </header>
      {flash.status && <p role="status">{flash.status}</p>}
      <h1>Dashboard</h1>
      {!verified && (
        <p role="note">
          Please confirm your e-mail address — the link is in your inbox.{' '}
          <Link method="post" href="/email/verification-notification">
            Send it again
          </Link>
        </p>
      )}
      <p>
        <Link href="/settings/security">Security</Link> · <Link href="/settings/tokens">API tokens</Link>
      </p>
    </main>
  );
}

import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowDashboardController } from '../controllers/ShowDashboardController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowDashboardController>;

export default function Dashboard({ name, verified }: Props) {
  return (
    <main>
      <Head title="Dashboard" />
      <h1>Dashboard</h1>
      <p>Welcome, {name}.</p>
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

Dashboard.layout = AppLayout;

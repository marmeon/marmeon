import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';
import { AppLayout } from '../layouts/AppLayout.tsx';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email }: Props) {
  return (
    <main>
      <Head title="Confirm your e-mail address" />
      <h1>Confirm your e-mail address</h1>
      <p>We sent a link to {email}. Click it to confirm the address.</p>
      <p>
        <Link route="auth.verification.send">
          Send the link again
        </Link>{' '}
        · <Link route="dashboard">Back to the dashboard</Link>
      </p>
    </main>
  );
}

VerifyEmail.layout = AppLayout;

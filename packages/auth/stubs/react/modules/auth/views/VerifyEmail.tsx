import type { PageProps } from '@bespokecore/http';
import { Head, Link } from '@bespokecore/react';
import type { ShowVerifyEmailNoticeController } from '../controllers/ShowVerifyEmailNoticeController.ts';

type Props = PageProps<ShowVerifyEmailNoticeController>;

export default function VerifyEmail({ email, flash }: Props) {
  return (
    <main>
      <Head title="Confirm your e-mail address" />
      <h1>Confirm your e-mail address</h1>
      {flash.status && <p role="status">{flash.status}</p>}
      <p>We sent a link to {email}. Click it to confirm the address.</p>
      <p>
        <Link method="post" href="/email/verification-notification">
          Send the link again
        </Link>{' '}
        · <Link href="/dashboard">Back to the dashboard</Link>
      </p>
    </main>
  );
}

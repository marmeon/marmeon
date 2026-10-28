import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import type { ConfirmUnsubscribeController } from '../controllers/ConfirmUnsubscribeController.ts';

/** The page behind the unsubscribe link of a mail: one button, a form that posts to the address the page was opened at. */
export default function ConfirmUnsubscribe({ title, body, button, action }: PageProps<ConfirmUnsubscribeController>) {
  return (
    <main>
      <Head title={title} />
      <h1>{title}</h1>
      <p>{body}</p>
      <form method="post" action={action}>
        <button type="submit">{button}</button>
      </form>
    </main>
  );
}

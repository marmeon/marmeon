import type { PageProps } from '@marmeon/http';
import { Form, Head, Link, useTranslation } from '@marmeon/react';
import type { ShowSessionsController } from '../ShowSessionsController.ts';

type Props = PageProps<ShowSessionsController>;
type SignIn = Props['signIns'][number];

/** One row of the list; ending a row is a request of its own, behind the sudo mode. */
function Row({ signIn }: { signIn: SignIn }) {
  const t = useTranslation('office');
  return (
    <li>
      {signIn.device.browser ?? t('sessions.unknown')}
      {signIn.device.system ? ` (${signIn.device.system})` : ''}
      {signIn.current ? (
        <small> — {t('sessions.current')}</small>
      ) : (
        <Form route="office.sessions.end" params={{ signIn: signIn.id }}>
          <button type="submit">{t('sessions.end')}</button>
        </Form>
      )}
    </li>
  );
}

/** The editor's own sign-ins, the current browser first. */
export default function Sessions({ signIns }: Props) {
  const t = useTranslation('office');
  return (
    <main data-area="office">
      <Head title={t('sessions.title')} />
      <h1>{t('sessions.title')}</h1>
      <ul>
        {signIns.map((signIn) => (
          <Row key={signIn.id} signIn={signIn} />
        ))}
      </ul>
      <p>
        <Link route="office.index">{t('sessions.back')}</Link>
      </p>
    </main>
  );
}

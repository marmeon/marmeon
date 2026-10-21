import type { PageProps } from '@marmeon/http';
import { Form, Head } from '@marmeon/react';
import { AppLayout } from '../../auth/layouts/AppLayout.tsx';
import type { ShowAccountExportController } from '../controllers/ShowAccountExportController.ts';

type Props = PageProps<ShowAccountExportController>;

export default function ShowAccountExport(_props: Props) {
  return (
    <main className="app-main stack stack-loose">
      <Head title="Your account data" />
      <h1>Your account data</h1>
      <section className="card">
        <p>We send your name, your e-mail address and the day you signed up to the address of your account.</p>
        <Form route="account-export.request" className="stack">
          {(form) => (
            <button type="submit" className="button" disabled={form.processing}>
              Email me my account data
            </button>
          )}
        </Form>
      </section>
    </main>
  );
}

ShowAccountExport.layout = AppLayout;

import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowErrorsLabController } from '../controllers/ShowLabPageController.ts';

/**
 * Errors on purpose: each link fails in its own way. In development (`marmeon dev`) the error page shows the
 * code, the request, the queries and the solution; in production the plain error page. Plain links load the page, the
 * buttons visit it — the error page then shows in the visit's dialog.
 */
export default function Errors({ kinds, recent }: PageProps<ShowErrorsLabController>) {
  return (
    <main>
      <Head title="Trigger an error" />
      <h1>Trigger an error</h1>
      <p>Each one fails on purpose. In development the error page shows what went wrong and how to fix it.</p>
      <ul data-error-kinds>
        {kinds.map(({ kind, label }) => (
          <li key={kind}>
            <a href={`/lab/errors/${kind}`} data-kind={kind}>
              {label}
            </a>{' '}
            · <Link href={`/lab/errors/${kind}`} data-visit={kind}>as a visit</Link>
          </li>
        ))}
      </ul>
      <h2>Reported errors</h2>
      <p>The last server errors, failed jobs, failed scheduled tasks and failed commands as an error reporter gets them: masked, newest first.</p>
      <ul data-recent-errors>
        {recent.map((report, index) => (
          <li key={index}>
            <code>{report.name}</code> {report.message} · {report.source} {report.where}
          </li>
        ))}
      </ul>
    </main>
  );
}

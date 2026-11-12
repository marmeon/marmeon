import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ShowHelpPageController } from '../controllers/ShowHelpPageController.ts';

/** A help page, or the list of them when no page is asked for. */
export default function Show({ page, pages }: PageProps<ShowHelpPageController>) {
  return (
    <main>
      <Head title={page?.title ?? 'Help'} />
      <h1>{page?.title ?? 'Help'}</h1>
      {page ? (
        <>
          <p>{page.body}</p>
          <p>
            <Link route="help.page">All help pages</Link>
          </p>
        </>
      ) : (
        <ul>
          {pages.map((entry) => (
            <li key={entry.path}>
              <Link route="help.page" params={{ path: entry.path }}>
                {entry.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

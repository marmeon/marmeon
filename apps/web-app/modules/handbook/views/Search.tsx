import type { PageProps } from '@marmeon/http';
import { Head, useTranslation } from '@marmeon/react';
import type { ExcerptSegment } from '@marmeon/search';
import { Pagination } from '../../../layouts/Pagination.tsx';
import type { SearchHandbookController } from '../controllers/SearchHandbookController.ts';

/** The search form and one page of hits, articles and questions in one list. */
export default function Search({ q, entries, meta, unavailable }: PageProps<SearchHandbookController>) {
  const t = useTranslation('handbook');
  return (
    <main className="stack">
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <form method="get" role="search" className="cluster">
        <input type="search" name="q" defaultValue={q} maxLength={100} aria-label={t('term')} />
        <button type="submit">{t('search')}</button>
      </form>
      {unavailable && <p role="alert">{t('unavailable')}</p>}
      {!unavailable && q !== '' && entries.length === 0 && <p className="muted">{t('none', { term: q })}</p>}
      <ol className="stack">
        {entries.map((entry) => (
          <li key={`${entry.kind}-${entry.id}`}>
            <small className="muted">{t(entry.kind)}</small>
            <h2>{entry.title}</h2>
            <Excerpt segments={entry.excerpt} />
          </li>
        ))}
      </ol>
      {meta && <Pagination meta={meta} />}
    </main>
  );
}

/** An excerpt is segments of text, never HTML: React escapes every one, and only the matches are wrapped in `<mark>`. */
function Excerpt({ segments }: { segments: readonly ExcerptSegment[] }) {
  if (segments.length === 0) return null;
  return <p>{segments.map((segment, i) => (segment.match ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>))}</p>;
}

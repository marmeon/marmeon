import type { PageProps } from '@marmeon/http';
import { Head, useTranslation } from '@marmeon/react';
import type { ExportMembersController } from '../controllers/ExportMembersController.ts';

/** The files of the members table, linked without the table: each address comes from `tables.exports()`. */
export default function Exports({ exports }: PageProps<ExportMembersController>) {
  const t = useTranslation('members');
  return (
    <main>
      <Head title={t('exports_title')} />
      <h1>{t('exports_title')}</h1>
      <p>{t('exports_intro')}</p>
      {exports.length === 0 ? (
        <p>{t('exports_none')}</p>
      ) : (
        <ul>
          {exports.map((entry) => (
            <li key={entry.name}>
              <a href={entry.url} download data-export={entry.name}>
                {t('export')} ({entry.name})
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

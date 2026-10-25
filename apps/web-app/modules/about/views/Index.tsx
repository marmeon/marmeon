import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowAboutController } from '../controllers/ShowAboutController.ts';

/** The public list of features. */
export default function Index({ features }: PageProps<ShowAboutController>) {
  const t = useTranslation('about');
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <ul>
        {features.map((feature) => (
          <li key={feature.slug}>
            <Link route="about.features.show" params={{ feature: feature.slug }} prefetch="viewport">
              {t(`features.${feature.slug}.title`)}
            </Link>
            {' — '}
            {t(`features.${feature.slug}.summary`)}
          </li>
        ))}
      </ul>
    </main>
  );
}

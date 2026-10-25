import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowAboutController } from '../controllers/ShowAboutController.ts';
import { LanguageSwitch } from '../layouts/LanguageSwitch.tsx';

/** The public list of features. */
export default function Index({ features }: PageProps<ShowAboutController>) {
  const t = useTranslation('about');
  return (
    <main>
      <Head
        title={t('title')}
        description={t('intro')}
        openGraph={{ type: 'website', siteName: 'Marmeon', title: t('title') }}
        twitter={{ card: 'summary' }}
      />
      <LanguageSwitch label={t('language')} />
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

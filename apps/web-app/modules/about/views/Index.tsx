import type { PageProps } from '@marmeon/http';
import { Head, Link, useLocale, useRoute, useTranslation } from '@marmeon/react';
import type { ShowAboutController } from '../controllers/ShowAboutController.ts';

/** The public list of features. */
export default function Index({ features }: PageProps<ShowAboutController>) {
  const t = useTranslation('about');
  const route = useRoute();
  const { locale } = useLocale();
  return (
    <main>
      <Head
        title={t('title')}
        description={t('intro')}
        canonical={route('about.index', { locale })}
        openGraph={{ type: 'website', siteName: 'Marmeon', title: t('title') }}
        twitter={{ card: 'summary' }}
      />
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <ul>
        {features.map((feature) => (
          <li key={feature.slug}>
            <Link route="about.features.show" params={{ locale, feature: feature.slug }} prefetch="viewport">
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

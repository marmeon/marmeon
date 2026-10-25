import type { PageProps } from '@marmeon/http';
import { Head, Link, useLocale, useRoute, useTranslation } from '@marmeon/react';
import type { ShowFeatureController } from '../controllers/ShowFeatureController.ts';

/** One feature of the public list. */
export default function Feature({ feature }: PageProps<ShowFeatureController>) {
  const t = useTranslation('about');
  const route = useRoute();
  const { locale } = useLocale();
  const path = route('about.features.show', { locale, feature: feature.slug });
  return (
    <main>
      <Head
        title={t(`features.${feature.slug}.title`)}
        description={t(`features.${feature.slug}.summary`)}
        canonical={path}
        openGraph={{ type: 'article', siteName: 'Marmeon', url: path, article: { modifiedTime: feature.updatedAt } }}
        twitter={{ card: 'summary' }}
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: t(`features.${feature.slug}.title`),
          description: t(`features.${feature.slug}.summary`),
          dateModified: feature.updatedAt,
          publisher: { '@type': 'Organization', name: 'Marmeon' },
        }}
      />
      <h1>{t(`features.${feature.slug}.title`)}</h1>
      <p>{t(`features.${feature.slug}.summary`)}</p>
      <p className="muted">{t('updated', { date: t.format.date(feature.updatedAt, { dateStyle: 'medium', timeZone: 'UTC' }) })}</p>
      <p>
        <Link route="about.index" params={{ locale }} preload="viewport">{t('back')}</Link>
      </p>
    </main>
  );
}

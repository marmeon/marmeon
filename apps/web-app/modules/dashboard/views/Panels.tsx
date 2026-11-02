import type { PageProps } from '@marmeon/http';
import { Head, Island, useTranslation } from '@marmeon/react';
import type { ShowPanelsController } from '../controllers/ShowPanelsController.ts';

type Props = PageProps<ShowPanelsController>;

/**
 * Panels the server chose: it sends each one's URL, and `<Island href>` loads it. The URL must be a path of this site;
 * each island's own route still decides who may see it.
 */
export default function Panels({ panels }: Props) {
  const t = useTranslation('dashboard');
  const loading = <p aria-busy="true">{t('loading')}</p>;
  const titles = { sign_ins: t('sign_ins.title'), members: t('members.title') };
  return (
    <main>
      <Head title={t('panels.title')} />
      <h1>{t('panels.title')}</h1>
      <p>{t('panels.intro')}</p>
      {panels.map((panel) => (
        <section key={panel.key} aria-label={titles[panel.key as keyof typeof titles]}>
          <h2>{titles[panel.key as keyof typeof titles]}</h2>
          <Island href={panel.url} fallback={loading} unauthorized={<p>{t('members.hidden')}</p>} />
        </section>
      ))}
    </main>
  );
}

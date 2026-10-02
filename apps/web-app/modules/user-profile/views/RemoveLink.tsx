import type { PageProps } from '@bespokecore/http';
import { Head, Link, useLayer, useTranslation } from '@bespokecore/react';
import type { ConfirmRemoveLinkController } from '../controllers/ConfirmRemoveLinkController.ts';

type Props = PageProps<ConfirmRemoveLinkController>;

/** "Remove this link?" — a layer over the profile, or over the edit layer (depth 2). Removing closes it (`closeLayer()`). */
export default function RemoveLink({ link, userId }: Props) {
  const t = useTranslation('user-profile');
  const layer = useLayer<ConfirmRemoveLinkController>();
  return (
    <section>
      <Head title={t('remove.title', { label: link.label })} />
      <h2>{t('remove.title', { label: link.label })}</h2>
      <p>
        <code>{link.url}</code>
      </p>
      <p data-layer-description="">{t('remove.text')}</p>
      <p>
        {/* The safe choice first, and focused. */}
        <button type="button" autoFocus onClick={() => void layer.close()}>
          {t('remove.keep')}
        </button>{' '}
        {/* A DELETE — a <button> sending the visit as the layer's: the answer closes it (`closeLayer()`). */}
        <Link route="user-profile.links.destroy" params={{ user: userId, link: link.id }}>
          {t('remove.confirm')}
        </Link>
      </p>
    </section>
  );
}

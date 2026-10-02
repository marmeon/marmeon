import type { PageProps } from '@bespokecore/http';
import { Head, useLayer, useTranslation } from '@bespokecore/react';
import type { CreateAccessTokenController } from '../controllers/CreateAccessTokenController.ts';

type Props = PageProps<CreateAccessTokenController>;

/**
 * The new token's plain text — the answer of creating it, a layer shown once (E53): closed (this button, Escape, Back), it
 * is gone from the tab's memory as well, and the list beneath reloads with the token in it.
 */
export default function NewAccessToken({ name, plainText }: Props) {
  const t = useTranslation('auth');
  const layer = useLayer<CreateAccessTokenController>();
  return (
    <section>
      <Head title={t('tokens.new')} />
      <h2>{t('tokens.new')}: {name}</h2>
      {/* The dialog's description: read with its name when it opens (focus goes to "Done"). */}
      <p data-layer-description="">
        <strong>{t('tokens.copy')}</strong>
      </p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        <code>{plainText}</code>
      </pre>
      <p>
        {t('tokens.usage')} <code>curl -H "Authorization: Bearer {plainText.slice(0, 8)}…" /api/users</code>
      </p>
      <button type="button" autoFocus onClick={() => void layer.close()}>
        {t('tokens.done')}
      </button>
    </section>
  );
}

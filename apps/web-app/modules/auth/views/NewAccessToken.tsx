import type { PageProps } from '@marmeon/http';
import { Head, Link, useLayer, useTranslation } from '@marmeon/react';
import type { StoreAccessTokenController } from '../controllers/StoreAccessTokenController.ts';

type Props = PageProps<StoreAccessTokenController>;

/**
 * The new token's plain text — the answer of creating it, a layer shown once: closed (Done, Escape, Back), it
 * is gone from the tab's memory as well, and the list beneath reloads with the token in it.
 */
export default function NewAccessToken({ name, plainText }: Props) {
  const t = useTranslation('auth');
  const layer = useLayer<StoreAccessTokenController>();
  return (
    <section>
      <Head title={t('tokens.new')} />
      <h2>{t('tokens.new')}: {name}</h2>
      {/* The dialog's description: read with its name when it opens (focus goes to "Done": the first control of the dialog, which `showModal()` focuses). */}
      <p data-layer-description="">
        <strong>{t('tokens.copy')}</strong>
      </p>
      <pre className="wrap">
        <code>{plainText}</code>
      </pre>
      <p>
        {t('tokens.usage')} <code>curl -H "Authorization: Bearer {plainText.slice(0, 8)}…" /api/users</code>
      </p>
      {/* A link to the layer's base page, so a document without JavaScript can leave the layer too. `autoFocus` only counts in the server-rendered document: React never focuses an anchor in the browser, `showModal()` does, and Done is the first control. */}
      <Link
        route="auth.tokens"
        autoFocus
        onClick={(event) => {
          // Not a layer (an answer without `.layer()`, or one beyond the tenth): the link navigates. In a layer it closes the layer instead of visiting the page.
          if (!layer.isLayer) return;
          event.preventDefault();
          void layer.close();
        }}
      >
        {t('tokens.done')}
      </Link>
    </section>
  );
}

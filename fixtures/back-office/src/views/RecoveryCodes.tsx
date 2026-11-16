import { Head, Link, useLayer, useTranslation } from '@marmeon/react';

/**
 * The new recovery codes: the answer of turning the factor on or making new ones, a layer over the security page. Closed (Done, Escape, Back),
 * it is gone from the tab's memory as well, and the page beneath reloads. They are never in a page of the history.
 */
export default function RecoveryCodes({ codes, signedOut }: { codes: string[]; signedOut: boolean }) {
  const t = useTranslation('office');
  const layer = useLayer();
  return (
    <section data-area="office">
      <Head title={t('codes.title')} />
      <h2>{t('codes.title')}</h2>
      {/* The dialog's description: read with its name when it opens (focus goes to "Done": the first control of the dialog, which `showModal()` focuses). */}
      <p data-layer-description="">
        <strong>{t('codes.intro')}</strong>
      </p>
      <ul>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      {signedOut && <p>{t('codes.signedOut')}</p>}
      {/* A link to the layer's base page, so a document without JavaScript can leave the layer too. `autoFocus` only counts in the server-rendered document: React never focuses an anchor in the browser, `showModal()` does, and Done is the first control. */}
      <Link
        route="office.security"
        autoFocus
        onClick={(event) => {
          // Not a layer (an answer without `.layer()`, or one beyond the tenth): the link navigates. In a layer it closes the layer instead of visiting the page.
          if (!layer.isLayer) return;
          event.preventDefault();
          void layer.close();
        }}
      >
        {t('codes.done')}
      </Link>
    </section>
  );
}

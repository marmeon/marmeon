import { Head, useLayer, useTranslation } from '@marmeon/react';

/**
 * The new recovery codes: the answer of turning the factor on or making new ones, a layer over the security page. Closed (the button, Escape, Back),
 * it is gone from the tab's memory as well, and the page beneath reloads. They are never in a page of the history.
 */
export default function RecoveryCodes({ codes, signedOut }: { codes: string[]; signedOut: boolean }) {
  const t = useTranslation('office');
  const layer = useLayer();
  return (
    <section data-area="office">
      <Head title={t('codes.title')} />
      <h2>{t('codes.title')}</h2>
      {/* The dialog's description: read with its name when it opens. */}
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
      <button type="button" autoFocus onClick={() => void layer.close()}>
        {t('codes.done')}
      </button>
    </section>
  );
}

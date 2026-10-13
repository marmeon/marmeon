import { Head, useLayer, useTranslation } from '@marmeon/react';

/**
 * The new recovery codes — the answer of turning the factor on or making new ones, a layer shown once: closed (this button,
 * Escape, Back), it is gone from the tab's memory as well, and the page beneath reloads.
 */
export default function RecoveryCodes({ codes }: { codes: string[] }) {
  const t = useTranslation('auth');
  const layer = useLayer();
  return (
    <section>
      <Head title={t('two_factor.codes_heading')} />
      <h2>{t('two_factor.codes_heading')}</h2>
      {/* The dialog's description: read with its name when it opens (focus goes to "Done"). */}
      <p data-layer-description="">
        <strong>{t('two_factor.codes_intro')}</strong>
      </p>
      <ul>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <button type="button" autoFocus onClick={() => void layer.close()}>
        {t('two_factor.codes_done')}
      </button>
    </section>
  );
}

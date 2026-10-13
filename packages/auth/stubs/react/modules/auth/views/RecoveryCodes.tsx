import { Head, Link, useLayer, useTranslation } from '@marmeon/react';

/**
 * The new recovery codes — the answer of turning the factor on or making new ones, a layer shown once: closed (this button,
 * Escape, Back), it is gone from the tab's memory as well, and the page beneath reloads.
 */
export default function RecoveryCodes({ codes, tokens }: { codes: string[]; tokens: { id: number; name: string }[] | null }) {
  const t = useTranslation('auth');
  const layer = useLayer();
  return (
    <section className="stack">
      <Head title={t('two_factor.codes_heading')} />
      <h2>{t('two_factor.codes_heading')}</h2>
      {/* The dialog's description: read with its name when it opens (focus goes to "Done"). */}
      <p data-layer-description="">
        <strong>{t('two_factor.codes_intro')}</strong>
      </p>
      <ul className="auth-codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      {/* Only when the factor was just turned on: what that did, and what it left alone. */}
      {tokens && (
        <>
          <p>{t('two_factor.devices_signed_out')}</p>
          <h3>{t('two_factor.tokens_heading')}</h3>
          {tokens.length === 0 ? (
            <p>{t('two_factor.tokens_none')}</p>
          ) : (
            <>
              <p>{t('two_factor.tokens_note')}</p>
              <ul>
                {tokens.map((token) => (
                  <li key={token.id}>{token.name}</li>
                ))}
              </ul>
              <p>
                <Link route="auth.tokens">{t('two_factor.tokens_review')}</Link>
              </p>
            </>
          )}
        </>
      )}
      <button type="button" className="button" autoFocus onClick={() => void layer.close()}>
        {t('two_factor.codes_done')}
      </button>
    </section>
  );
}

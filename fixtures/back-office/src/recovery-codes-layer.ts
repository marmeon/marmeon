/**
 * The layer that shows recovery codes once: it answers a POST (turning the factor on, making new codes) over the security page, so the codes never sit in
 * the session or in the history entries, and when it closes they are gone from the tab's memory too.
 */
export const CODES_LAYER = { base: 'office.security', key: 'office.two-factor.codes' } as const;

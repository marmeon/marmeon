/** Where Fathom serves its script and receives the pageviews. */
export const FATHOM_ORIGIN = 'https://cdn.usefathom.com';

/** The one script the policy allows beside `'self'`. */
export const FATHOM_SCRIPT = `${FATHOM_ORIGIN}/script.js`;

/** A Fathom site id: uppercase letters and digits. Nothing else ever reaches the document or the policy. */
export const FATHOM_SITE_PATTERN = /^[A-Z0-9]{4,16}$/;

/**
 * Fathom's script as the head carries it: external (the policy allows no inline script) and `defer`. `data-auto="false"`: no
 * pageview on its own — `Pageviews` sends every one, the first included, because Fathom reads the query string of the address
 * bar (the docs search puts the search terms there) and `Pageviews` leaves such pages out. Fathom's `data-spa` mode would miss
 * the visits anyway: the client router does not use the history API it watches.
 */
export function fathomScript(site: string): string {
  if (!FATHOM_SITE_PATTERN.test(site)) throw new Error('The Fathom site id must be 4 to 16 uppercase letters and digits.');
  return `<script src="${FATHOM_SCRIPT}" data-auto="false" data-site="${site}" defer></script>`;
}

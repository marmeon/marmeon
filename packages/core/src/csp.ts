/**
 * What stands for a response's CSP nonce in a document template until the server renders it (E147): the Vite plugin
 * (`marmeon()`) sets it as Vite's `html.cspNonce`, so every `<script>`, `<style>` and preload tag of `index.html` carries
 * `nonce="__marmeon_csp_nonce__"` — and the server puts the response's nonce in its place, or takes the attribute out
 * when the response has none. Development HTML a package adds to documents (`DevDocument`) writes it the same way.
 */
export const CSP_NONCE_PLACEHOLDER = '__marmeon_csp_nonce__';

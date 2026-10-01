// A module's source messages — the fixture app of the i18n tests (no `Translations` declaration: the package's own types stay generic).
export default {
  greeting: 'Hello {name}',
  cart: '{count, plural, =0 {Your cart is empty} one {# item in your cart} other {# items in your cart}}',
  validation: { name_min: 'The name needs at least {requirement} characters.', email: 'Enter a valid e-mail address.' },
  html: 'Use <b>bold</b> & {value}',
};

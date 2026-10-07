/**
 * The framework's own texts (namespace `marmeon`) — status pages, framework errors, the rules of
 * @marmeon/auth. Each package keeps the English text inline as well, for apps without this package.
 */
const en = {
  status: {
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '403': 'Forbidden',
    '404': 'Not Found',
    '405': 'Method Not Allowed',
    '413': 'Content Too Large',
    '415': 'Unsupported Media Type',
    '419': 'Page Expired',
    '422': 'Unprocessable Content',
    '423': 'Locked',
    '429': 'Too Many Requests',
    '500': 'Server Error',
    '503': 'Service Unavailable',
  },
  errors: {
    unauthorized: 'This action is unauthorized.',
    csrf: 'CSRF token mismatch.',
    cross_site: 'Cross-site request refused.',
    throttled: 'Too Many Attempts.',
    signature: 'Invalid signature.',
  },
  validation: {
    password: {
      required: 'Enter a password.',
      min: 'The password needs at least {min} characters.',
      max: 'The password is too long.',
    },
    confirmed: 'The passwords do not match.',
    upload: {
      required: 'Choose a file.',
      invalid: 'The file did not arrive — choose it again.',
      expired: 'The upload expired — choose the file again.',
      used: 'This file was saved already — choose it again.',
      max: 'The file may be at most {max}.',
      type: 'This type of file is not accepted (allowed: {types}).',
    },
    more: '(and {count, plural, one {# more error} other {# more errors}})',
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    marmeon: typeof en;
  }
}

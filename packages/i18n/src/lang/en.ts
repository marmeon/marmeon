/**
 * The framework's own texts (namespace `marmeon`) — status pages, framework errors, the rules of
 * @marmeon/validation and @marmeon/auth. Each package keeps the English text inline as well, for apps without this package.
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
    // The rules of @marmeon/validation (E197) — the same English as its VALIDATION_TEXTS (a test keeps them equal).
    required: 'The {attribute} field is required.',
    string: 'The {attribute} field must be a string.',
    number: 'The {attribute} field must be a number.',
    integer: 'The {attribute} field must be an integer.',
    boolean: 'The {attribute} field must be true or false.',
    accepted: 'The {attribute} field must be accepted.',
    object: 'The {attribute} field must be an object.',
    array: 'The {attribute} field must be a list.',
    in: 'The selected {attribute} is invalid.',
    union: 'The {attribute} field is invalid.',
    custom: 'The {attribute} field is invalid.',
    min: {
      string: 'The {attribute} field must be at least {min} characters.',
      number: 'The {attribute} field must be at least {min}.',
      array: 'The {attribute} field must have at least {min} items.',
    },
    max: {
      string: 'The {attribute} field must not be longer than {max} characters.',
      number: 'The {attribute} field must not be greater than {max}.',
      array: 'The {attribute} field must not have more than {max} items.',
    },
    between: {
      string: 'The {attribute} field must be between {min} and {max} characters.',
      number: 'The {attribute} field must be between {min} and {max}.',
      array: 'The {attribute} field must have between {min} and {max} items.',
    },
    email: 'The {attribute} field must be a valid email address.',
    url: 'The {attribute} field must be a valid URL.',
    uuid: 'The {attribute} field must be a valid UUID.',
    regex: 'The {attribute} field format is invalid.',
    date: 'The {attribute} field must be a valid date.',
    iso_timestamp: 'The {attribute} field must be a valid date and time.',
    confirmation: 'The {attribute} does not match.',
    unique: 'The {attribute} has already been taken.',
    exists: 'The selected {attribute} is invalid.',
    port: 'The {attribute} field must be a port number from 1 to 65535.',
  },
} as const;

export default en;

declare module '@marmeon/i18n/messages' {
  interface Translations {
    marmeon: typeof en;
  }
}

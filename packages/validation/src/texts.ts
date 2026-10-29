/**
 * The English texts of the rules — what a message reads without @marmeon/i18n (and what its `marmeon.validation.*` keys say
 * in English: @marmeon/i18n has them too, with German, and a test keeps both the same). `{attribute}` is the field's name,
 * the other placeholders are the rule's parameters.
 */
export const VALIDATION_TEXTS = {
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
  local_date_time: 'The {attribute} field must be a date and time like 2026-10-07T14:30.',
  time_zone: 'The {attribute} field must be a time zone such as Europe/Berlin.',
  confirmed: 'The {attribute} does not match.',
  unique: 'The {attribute} has already been taken.',
  exists: 'The selected {attribute} is invalid.',
  port: 'The {attribute} field must be a port number from 1 to 65535.',
} as const;

type Texts = typeof VALIDATION_TEXTS;
type KeysOf<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : KeysOf<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** A rule's key below `marmeon.validation.`: `required`, `max.string` … */
export type TextKey = KeysOf<Texts>;

/** The English text of `key`. */
export function englishText(key: TextKey): string {
  let node: unknown = VALIDATION_TEXTS;
  for (const segment of key.split('.')) node = (node as Record<string, unknown>)[segment];
  return node as string;
}

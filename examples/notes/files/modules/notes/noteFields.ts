import { rules as r } from '@marmeon/validation';

/** What a note's form sends: a title, and a body that may stay empty. Nothing else — the owner is the signed-in user. */
export const noteFields = r.object({
  title: r.string().trim().required().max(120),
  body: r.string().max(10_000),
});

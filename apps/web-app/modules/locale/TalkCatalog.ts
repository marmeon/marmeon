import type { RouteBinder } from '@marmeon/http';

/** A talk with the language it is held in. */
export interface Talk {
  readonly slug: string;
  readonly title: string;
  /** A locale tag; the app may not support it. */
  readonly language: string;
  readonly takesQuestions: boolean;
}

const TALKS: readonly Talk[] = [
  { slug: 'routing', title: 'Typed routes', language: 'en', takesQuestions: true },
  { slug: 'sprachen', title: 'Sprachen im Request', language: 'de', takesQuestions: true },
  { slug: 'ruhe', title: 'Stille Vorträge', language: 'de', takesQuestions: false },
  { slug: 'langues', title: 'Les langues', language: 'fr', takesQuestions: false },
];

/** The talks of the example, and the binder of `/talks/:talk`. */
export class TalkCatalog implements RouteBinder<Talk> {
  resolveRouteBinding(slug: string): Talk | undefined {
    return TALKS.find((talk) => talk.slug === slug);
  }
}

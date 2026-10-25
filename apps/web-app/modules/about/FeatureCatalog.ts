export type FeatureSlug = 'typed-routes' | 'instant-visits' | 'server-rendering' | 'translations';

/** One feature the public pages describe. Its title and summary are texts of the `about` language files, under `features.<slug>`. `updatedAt` is an ISO 8601 string, so it travels as a page prop as it is. */
export interface Feature {
  readonly slug: FeatureSlug;
  readonly updatedAt: string;
}

const FEATURES: readonly Feature[] = [
  { slug: 'typed-routes', updatedAt: '2026-03-02T09:00:00Z' },
  { slug: 'instant-visits', updatedAt: '2026-04-14T09:00:00Z' },
  { slug: 'server-rendering', updatedAt: '2026-05-20T09:00:00Z' },
  { slug: 'translations', updatedAt: '2026-06-08T09:00:00Z' },
];

/** The features the public pages show: a fixed list, the same for everyone. */
export class FeatureCatalog {
  all(): readonly Feature[] {
    return FEATURES;
  }

  /** The feature with this slug, if there is one. */
  find(slug: string): Feature | undefined {
    return FEATURES.find((candidate) => candidate.slug === slug);
  }
}

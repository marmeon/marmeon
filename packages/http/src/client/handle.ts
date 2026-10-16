declare const featureApi: unique symbol;

/**
 * What an app passes to its adapter to use a feature of the client core: `useFeature(hooks)` in React. It carries the type of
 * the feature's API and nothing else; the feature itself is the adapter's (`@marmeon/http/client/adapter`), and only a feature
 * the core made is accepted.
 */
export interface FeatureHandle<API> {
  readonly name: string;
  readonly [featureApi]?: API;
}

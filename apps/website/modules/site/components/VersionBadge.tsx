import { usePage } from '@marmeon/react';

/** The framework's version, from the `site` once-prop; nothing where the prop is absent (an error page for an unknown path). A phone hides it, so that the wordmark and the menu share the header's line. */
export function VersionBadge() {
  const version = usePage().props.site?.version;
  return version ? <span className="badge version-badge">{version}</span> : null;
}

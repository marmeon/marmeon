import { usePage } from '@marmeon/react';

/** The framework's version, from the `site` once-prop; nothing where the prop is absent (an error page for an unknown path). */
export function VersionBadge() {
  const version = usePage().props.site?.version;
  return version ? <span className="badge">{version}</span> : null;
}

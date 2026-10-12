import type { AppConfig } from '../../config/app.ts';

/**
 * An absolute URL on this site, from `APP_URL` only. Never build one from the request's `Host` or `X-Forwarded-Host`: these
 * answers are cached publicly, and a forged host would be served to everybody and send crawlers to another domain.
 */
export function publicUrl(app: AppConfig, path: string): string {
  return new URL(path, app.url).href;
}

/** Whether `value` names an IANA time zone (`Europe/Berlin`, `UTC`) — the check behind `APP_TIMEZONE` and `SCHEDULE_TIMEZONE`. */
export function isTimeZone(value: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone name an app wrote in its IANA spelling (`europe/berlin` → `Europe/Berlin`; a link like `Asia/Calcutta` stays one), or undefined when it names no region
 * zone — a UTC offset (`+01:00`) is no zone a browser formats with. The name `APP_TIMEZONE` sends to the browser.
 */
export function canonicalTimeZone(value: string): string | undefined {
  if (/^[+-]/.test(value) || !isTimeZone(value)) return undefined;
  return Temporal.Now.zonedDateTimeISO(value).timeZoneId;
}

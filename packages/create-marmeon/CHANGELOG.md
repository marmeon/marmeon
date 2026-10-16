# create-marmeon

## 0.3.0

### Breaking changes

- End every session of an account with AccountSessions by @maxeckel in https://github.com/marmeon/marmeon/pull/38
- Ask for a fresh second factor before changing an account's factors by @maxeckel in https://github.com/marmeon/marmeon/pull/42
- Bound how long a sign-in, a remember-me cookie and a second-factor proof last by @maxeckel in https://github.com/marmeon/marmeon/pull/41
- Remove the cookie session driver by @maxeckel in https://github.com/marmeon/marmeon/pull/44
- Send the session cookie without Max-Age, so it ends when the browser closes by @maxeckel in https://github.com/marmeon/marmeon/pull/45
- Refuse to store a second factor for a session that ended meanwhile by @maxeckel in https://github.com/marmeon/marmeon/pull/46
- Listen on 127.0.0.1 unless HOST says otherwise by @maxeckel in https://github.com/marmeon/marmeon/pull/61
- Let a passkey confirm sudo mode by @maxeckel in https://github.com/marmeon/marmeon/pull/59
- Stop Vite from loading .env files and VITE_ variables unless asked to by @maxeckel in https://github.com/marmeon/marmeon/pull/81
- Anchor a password sign-in and its remember-me token to the account state it verified by @maxeckel in https://github.com/marmeon/marmeon/pull/76
- Require a confirmed address before an account owns a second factor or passkey by @maxeckel in https://github.com/marmeon/marmeon/pull/91
- Refuse `marmeon start` in development unless the process environment asks for it by @maxeckel in https://github.com/marmeon/marmeon/pull/68
- Close live streams under every key of an `APP_KEY` rotation by @maxeckel in https://github.com/marmeon/marmeon/pull/75
- Cap outstanding uploads per session and in total, and prune expired ones by @maxeckel in https://github.com/marmeon/marmeon/pull/80

### Features

- List an account's sign-ins and let it end one by @maxeckel in https://github.com/marmeon/marmeon/pull/50
- Tell the owner when a copied remember-me cookie is used by @maxeckel in https://github.com/marmeon/marmeon/pull/54
- End every session of every account at once, for the moment after a leak by @maxeckel in https://github.com/marmeon/marmeon/pull/56
- Stop password sign-ins to an account after 100 failures a day by @maxeckel in https://github.com/marmeon/marmeon/pull/92

### Fixes

- Refuse a remember token whose creation time is not a valid date by @maxeckel in https://github.com/marmeon/marmeon/pull/37
- End the thief's session too when a remember-me token is reused by @maxeckel in https://github.com/marmeon/marmeon/pull/39
- End every session when an operator resets an account's second factor by @maxeckel in https://github.com/marmeon/marmeon/pull/40
- Shorten the remember-me grace to 10 seconds and log who reused a cookie by @maxeckel in https://github.com/marmeon/marmeon/pull/47
- Ask for a fresh second factor before changing an account's e-mail address by @maxeckel in https://github.com/marmeon/marmeon/pull/48
- Measure every sign-in window on the app's clock by @maxeckel in https://github.com/marmeon/marmeon/pull/53
- Grant sudo mode only to a password typed for this sign-in by @maxeckel in https://github.com/marmeon/marmeon/pull/52
- Parse repeated form fields and query keys in linear time by @maxeckel in https://github.com/marmeon/marmeon/pull/62
- Keep a file session whose record is read while it is being rewritten by @maxeckel in https://github.com/marmeon/marmeon/pull/57
- Close the live streams of a sign-in that ended elsewhere by @maxeckel in https://github.com/marmeon/marmeon/pull/58
- Fetch client visits and actions from the origin that was checked by @maxeckel in https://github.com/marmeon/marmeon/pull/74
- Collapse leading slashes in derived redirects and refuse dot segments in route parameters by @maxeckel in https://github.com/marmeon/marmeon/pull/93
- Keep secret fields out of remembered and flashed form input by @maxeckel in https://github.com/marmeon/marmeon/pull/97
- Refuse non-http(s) targets in client navigation by @maxeckel in https://github.com/marmeon/marmeon/pull/96
- Read streamed island and deferred data only from their own script blocks by @maxeckel in https://github.com/marmeon/marmeon/pull/67
- Turn a cross-origin redirect of a page request into a full load on the server by @maxeckel in https://github.com/marmeon/marmeon/pull/83
- Keep Vite from serving storage, databases and build output in development by @maxeckel in https://github.com/marmeon/marmeon/pull/77
- Drop `__proto__` keys from JSON bodies and refuse JSON nested deeper than 256 levels by @maxeckel in https://github.com/marmeon/marmeon/pull/78
- Key client rate limits by IPv6 /64 and limit sign-ins per client by @maxeckel in https://github.com/marmeon/marmeon/pull/88
- Revoke a copied remember-me cookie in one statement, so a failure cannot hide the theft by @maxeckel in https://github.com/marmeon/marmeon/pull/65
- Tell the owner of every copied remember-me cookie, however often it rotated since by @maxeckel in https://github.com/marmeon/marmeon/pull/70
- Rehash a password only over the hash that was verified by @maxeckel in https://github.com/marmeon/marmeon/pull/89
- Make every failed sign-in take as long as the slowest stored hash by @maxeckel in https://github.com/marmeon/marmeon/pull/95
- Revoke API and reset tokens by default when ending every session by @maxeckel in https://github.com/marmeon/marmeon/pull/66
- Report a failed passkey confirmation only for an answer that was given by @maxeckel in https://github.com/marmeon/marmeon/pull/69
- Allow a minute of clock skew between servers in sudo and second-factor windows by @maxeckel in https://github.com/marmeon/marmeon/pull/90
- Send at most one account-exists mail per address an hour by @maxeckel in https://github.com/marmeon/marmeon/pull/86
- Check a list's size before its items and bound concurrent item checks by @maxeckel in https://github.com/marmeon/marmeon/pull/71
- Ignore every .env file in new apps and create .env readable by its owner only by @maxeckel in https://github.com/marmeon/marmeon/pull/79
- Fold column and table names in the write and secret guards, and check SET values by @maxeckel in https://github.com/marmeon/marmeon/pull/84
- Redact more secrets in logs and connection descriptions, and escape line breaks by @maxeckel in https://github.com/marmeon/marmeon/pull/85

### Documentation

- List every lifetime of a sign-in in one place by @maxeckel in https://github.com/marmeon/marmeon/pull/43

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.2.0...v0.3.0

## 0.2.0

### Breaking changes

- Add two-factor authentication with TOTP and recovery codes by @maxeckel in https://github.com/marmeon/marmeon/pull/16
- Refuse to start when a route does not say who may call it by @maxeckel in https://github.com/marmeon/marmeon/pull/33

### Features

- Add UUIDv7 keys, as primary keys or as public lookup keys by @maxeckel in https://github.com/marmeon/marmeon/pull/14
- Give the starter kit a look of its own by @maxeckel in https://github.com/marmeon/marmeon/pull/15
- Add a middleware that requires two-factor authentication on routes by @maxeckel in https://github.com/marmeon/marmeon/pull/17
- Add passkeys as a second factor and for passwordless sign-in by @maxeckel in https://github.com/marmeon/marmeon/pull/20
- Prove the second factor again with a passkey by @maxeckel in https://github.com/marmeon/marmeon/pull/24
- Add two-factor authentication pages to the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/26
- Add passkeys to the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/27
- Let route groups authorize their routes, and mark open ones with `everyone` by @maxeckel in https://github.com/marmeon/marmeon/pull/29

### Fixes

- Give the starter kit's tests time on a busy machine by @maxeckel in https://github.com/marmeon/marmeon/pull/11
- Stop sharing the user's id with every page of the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/12
- End new apps' page titles with the app's name by @maxeckel in https://github.com/marmeon/marmeon/pull/13
- Prune expired entries from the memory cache as it writes by @maxeckel in https://github.com/marmeon/marmeon/pull/21
- Expect the public profile id in the two-factor test by @maxeckel in https://github.com/marmeon/marmeon/pull/23
- Post the web app's two-factor forms even before hydration by @maxeckel in https://github.com/marmeon/marmeon/pull/25
- Send only the fields a profile page shows to other users by @maxeckel in https://github.com/marmeon/marmeon/pull/32
- Stop writing an `authorize` that always says yes to type a controller's context by @maxeckel in https://github.com/marmeon/marmeon/pull/31

### Documentation

- Add a guide that builds a small app step by step by @maxeckel in https://github.com/marmeon/marmeon/pull/19
- Say on the website whom Marmeon is for, and link the community by @maxeckel in https://github.com/marmeon/marmeon/pull/35

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.3...v0.2.0

## 0.1.3

### Fixes

- Ship the starter kit in German as well as English by @maxeckel in https://github.com/marmeon/marmeon/pull/4
- Sign out without making Chrome clear its whole disk cache by @maxeckel in https://github.com/marmeon/marmeon/pull/5
- Switch the language without clearing the browser's cache by @maxeckel in https://github.com/marmeon/marmeon/pull/6

### Documentation

- Link every package to its docs on marmeon.com and ship its changelog by @maxeckel in https://github.com/marmeon/marmeon/pull/3

### New contributors

- @maxeckel made their first contribution in https://github.com/marmeon/marmeon/pull/3

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.1.2...v0.1.3

## 0.1.2

No changes in this release.

## 0.1.1

### Patch Changes

- f56608b: Publish every package through the release workflow, with npm provenance.

## 0.1.0

### Minor Changes

- The first release (0.1.0): every package of the framework — the application kernel with constructor injection, the router, the
  page protocol and the React adapter, sessions, auth, the data layer, mail, queues, the scheduler, storage, live props, i18n, the
  devtools and OpenTelemetry — together with `create-marmeon`, all at one version.

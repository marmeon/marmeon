# @marmeon/react

## 1.0.0-rc.1

### Breaking changes

- Remove the pages and lang options of the Vite plugin by @maxeckel in https://github.com/marmeon/marmeon/pull/351
- Write every span of time as seconds or as a Duration object by @maxeckel in https://github.com/marmeon/marmeon/pull/337
- Declare primary keys in the generated table types by @maxeckel in https://github.com/marmeon/marmeon/pull/338
- Say the unit of every size in an environment variable's name by @maxeckel in https://github.com/marmeon/marmeon/pull/342
- Let packages bring mail transports and return the provider's message id by @maxeckel in https://github.com/marmeon/marmeon/pull/341
- Refuse a list of files or a file in an optional object when the routes load by @maxeckel in https://github.com/marmeon/marmeon/pull/346
- Make @marmeon/live stable by @maxeckel in https://github.com/marmeon/marmeon/pull/339
- Make @marmeon/devtools stable by @maxeckel in https://github.com/marmeon/marmeon/pull/340
- Give the message types of @marmeon/i18n names of their own by @maxeckel in https://github.com/marmeon/marmeon/pull/348
- Make the adapter interface of the client core stable by @maxeckel in https://github.com/marmeon/marmeon/pull/343
- Make the data tables stable by @maxeckel in https://github.com/marmeon/marmeon/pull/353
- Name the client's errors and the React router and action types apart by @maxeckel in https://github.com/marmeon/marmeon/pull/352
- Say the unit of retryAfter by @maxeckel in https://github.com/marmeon/marmeon/pull/354
- Rename the remaining names that two packages export by @maxeckel in https://github.com/marmeon/marmeon/pull/355
- Move the machinery of notifications, queue, database, auth, core and uploads to internal by @maxeckel in https://github.com/marmeon/marmeon/pull/356
- Keep the command classes internal and their names and flags public by @maxeckel in https://github.com/marmeon/marmeon/pull/359
- Name the unit of the client's spans of time by @maxeckel in https://github.com/marmeon/marmeon/pull/378
- Scope once props by the page's language, and drop the RegExp modifier by @maxeckel in https://github.com/marmeon/marmeon/pull/385
- Give a stopped job its attempt back, and keep queue.using(trx) inside its transaction by @maxeckel in https://github.com/marmeon/marmeon/pull/390
- Write the spans of time of core, router and the checks as Duration by @maxeckel in https://github.com/marmeon/marmeon/pull/391
- Refuse a /0 proxy range and show development details only to allowed hosts by @maxeckel in https://github.com/marmeon/marmeon/pull/392
- Connect to Postgres with a timeout and keep its session in UTC by @maxeckel in https://github.com/marmeon/marmeon/pull/393
- Make the context of every encryption explicit by @maxeckel in https://github.com/marmeon/marmeon/pull/397
- Give signed URLs one shape with a visible expiry by @maxeckel in https://github.com/marmeon/marmeon/pull/398
- Refuse an empty prefix on a named Redis connection by @maxeckel in https://github.com/marmeon/marmeon/pull/399
- Refuse a middleware list that would drop a layer by @maxeckel in https://github.com/marmeon/marmeon/pull/401
- Send a string as text and only Html as HTML by @maxeckel in https://github.com/marmeon/marmeon/pull/402
- Remove the remembered-field patterns deprecated for 0.5 by @maxeckel in https://github.com/marmeon/marmeon/pull/396
- Give twitter.image the shape of openGraph.image by @maxeckel in https://github.com/marmeon/marmeon/pull/403
- Let only a binder that scopes take scopedBy by @maxeckel in https://github.com/marmeon/marmeon/pull/387
- Reserve dev and start, and keep the launcher's entry out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/394
- Give access tokens, password changes and reset links safe defaults by @maxeckel in https://github.com/marmeon/marmeon/pull/400
- Read route patterns with one tokenizer everywhere by @maxeckel in https://github.com/marmeon/marmeon/pull/407
- Settle the scheduler's spans of time, time zone and task definition by @maxeckel in https://github.com/marmeon/marmeon/pull/408
- Write the spans of time of http and the server as Duration or with their unit by @maxeckel in https://github.com/marmeon/marmeon/pull/410
- Close the schema builder, transactions and migrator of @marmeon/database by @maxeckel in https://github.com/marmeon/marmeon/pull/411
- Refuse a signed link without an expiry unless the route allows it by @maxeckel in https://github.com/marmeon/marmeon/pull/409
- Never send a password or secret field with a live validation by @maxeckel in https://github.com/marmeon/marmeon/pull/405
- Move the machinery of @marmeon/http to internal by @maxeckel in https://github.com/marmeon/marmeon/pull/412
- Move the plumbing of server, storage, testing, table and devtools to internal by @maxeckel in https://github.com/marmeon/marmeon/pull/413
- Move the machinery of core, router and validation to internal by @maxeckel in https://github.com/marmeon/marmeon/pull/414
- Write the spans of time of queue, notifications and cache as Duration or with their unit by @maxeckel in https://github.com/marmeon/marmeon/pull/416
- Exit with 2 for every argument a command refuses by @maxeckel in https://github.com/marmeon/marmeon/pull/415
- Mark the live stream with its protocol version by @maxeckel in https://github.com/marmeon/marmeon/pull/418
- Name the units of the auth and session configs and take a Duration in their middleware by @maxeckel in https://github.com/marmeon/marmeon/pull/417
- Keep the constructors of the auth and session services out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/420
- Take the interval of usePoll and createPoll in their options by @maxeckel in https://github.com/marmeon/marmeon/pull/422
- Keep the constructors of the services the container builds out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/423
- Take a span or an options object where a parameter could be mistaken by @maxeckel in https://github.com/marmeon/marmeon/pull/425
- Move the names only the framework uses out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/426
- Keep a table's definition out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/429
- Take createPinoLogger's destination and app as options, and fix the locales once booted by @maxeckel in https://github.com/marmeon/marmeon/pull/430
- Keep the constructors and plumbing of core out of the API, and make Html only through html and raw() by @maxeckel in https://github.com/marmeon/marmeon/pull/431
- Keep the router's plumbing out of the API, and take block()'s spans by name by @maxeckel in https://github.com/marmeon/marmeon/pull/432
- List hidden commands apart from the API by @maxeckel in https://github.com/marmeon/marmeon/pull/441
- Cap temporary URLs at seven days on every disk, and keep the storage fake's plumbing internal by @maxeckel in https://github.com/marmeon/marmeon/pull/436
- Keep the request state and the page props' machinery out of @marmeon/http by @maxeckel in https://github.com/marmeon/marmeon/pull/433
- Keep the connections' plumbing internal, and name the Postgres options by @maxeckel in https://github.com/marmeon/marmeon/pull/434
- Keep the queue's and scheduler's plumbing internal, and name what sizes and due times mean by @maxeckel in https://github.com/marmeon/marmeon/pull/435
- Keep the auth stores, the session layout and the policy response out of the API, and require a name in abilities() by @maxeckel in https://github.com/marmeon/marmeon/pull/440
- Keep the session's lifecycle and the CSRF switch out of the API, and name flash data by @maxeckel in https://github.com/marmeon/marmeon/pull/437
- Name WhenVisible's reload, take resolveRoute options, and check an island's protocol by @maxeckel in https://github.com/marmeon/marmeon/pull/438
- Name the asset version and the live retry, and keep the mail fake and notification store internal by @maxeckel in https://github.com/marmeon/marmeon/pull/439
- Take a rate limit's numbers by name, and return a Result from a lock that waits by @maxeckel in https://github.com/marmeon/marmeon/pull/444
- Keep the members only the framework uses out of the API, and drop the pending list by @maxeckel in https://github.com/marmeon/marmeon/pull/445
- Keep the last types and members only the framework uses out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/448
- Keep the launcher's environment, the session id and the codec's encrypts out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/455
- Keep the framework's plumbing out of the API by @maxeckel in https://github.com/marmeon/marmeon/pull/456
- End a user's API tokens and reset links with their sessions by @maxeckel in https://github.com/marmeon/marmeon/pull/458
- Move the error pages and the layer backdrop into the system module by @maxeckel in https://github.com/marmeon/marmeon/pull/469

### Features

- Make @marmeon/otel stable by @maxeckel in https://github.com/marmeon/marmeon/pull/345
- Make marmeon tinker stable by @maxeckel in https://github.com/marmeon/marmeon/pull/349
- Run a command by its name in an app's tests by @maxeckel in https://github.com/marmeon/marmeon/pull/357
- Serve a group of routes under the locale in the URL by @maxeckel in https://github.com/marmeon/marmeon/pull/361
- Catch a page's error in its nearest layout, with a retry by @maxeckel in https://github.com/marmeon/marmeon/pull/362
- Preload the fonts an app names by @maxeckel in https://github.com/marmeon/marmeon/pull/365
- Render a page's placeholder in a test by @maxeckel in https://github.com/marmeon/marmeon/pull/372
- Warn in development about a slow visit without a placeholder by @maxeckel in https://github.com/marmeon/marmeon/pull/373
- Show errors/&lt;status> before errors/Error by @maxeckel in https://github.com/marmeon/marmeon/pull/368
- Give a named font a fallback with matching metrics by @maxeckel in https://github.com/marmeon/marmeon/pull/369
- Prefetch a link's page when it scrolls into view by @maxeckel in https://github.com/marmeon/marmeon/pull/364
- Give Head fields for search engines and link previews by @maxeckel in https://github.com/marmeon/marmeon/pull/363
- Serve a sitemap and robots.txt from the routes by @maxeckel in https://github.com/marmeon/marmeon/pull/370
- Put structured data into the document head by @maxeckel in https://github.com/marmeon/marmeon/pull/367
- Load a link's code ahead without asking the server by @maxeckel in https://github.com/marmeon/marmeon/pull/374
- Take the request's locale from the URL first by @maxeckel in https://github.com/marmeon/marmeon/pull/366
- Keep the page's locale in links and route() by @maxeckel in https://github.com/marmeon/marmeon/pull/371
- List every locale of a localized route in the sitemap by @maxeckel in https://github.com/marmeon/marmeon/pull/375
- Name every language of a localized page in its head by @maxeckel in https://github.com/marmeon/marmeon/pull/376
- Add Image with responsive sources by @maxeckel in https://github.com/marmeon/marmeon/pull/377
- Build responsive images from the app's files by @maxeckel in https://github.com/marmeon/marmeon/pull/379
- Verify the signature of an incoming webhook by @maxeckel in https://github.com/marmeon/marmeon/pull/384
- Take the table's query-builder needs from @marmeon/database by @maxeckel in https://github.com/marmeon/marmeon/pull/470
- Let an app add patterns the redactor masks, and give every redactor the app's additions by @maxeckel in https://github.com/marmeon/marmeon/pull/471
- Let an app reword and translate the framework's texts by @maxeckel in https://github.com/marmeon/marmeon/pull/473
- Leave the fields an app marks as secret out of flashed input by @maxeckel in https://github.com/marmeon/marmeon/pull/474
- Publish the framework's texts into an app with publish --only=lang by @maxeckel in https://github.com/marmeon/marmeon/pull/475

### Fixes

- List @marmeon/encryption among the packages a new app has by @maxeckel in https://github.com/marmeon/marmeon/pull/347
- Give each test process its own SQLite database file by @maxeckel in https://github.com/marmeon/marmeon/pull/381
- Keep the locale when closeLayer() redirects to a localized route by @maxeckel in https://github.com/marmeon/marmeon/pull/382
- Keep the scripts and styles of Head when the page hydrates by @maxeckel in https://github.com/marmeon/marmeon/pull/388
- Begin SQLite transactions at once, and count distinct pages right by @maxeckel in https://github.com/marmeon/marmeon/pull/389
- Keep the values of encrypted jobs out of failed_jobs and the log by @maxeckel in https://github.com/marmeon/marmeon/pull/406
- Pin an uploaded S3 object by its ETag and stream it into place by @maxeckel in https://github.com/marmeon/marmeon/pull/419
- Write the devtools' files for their owner only by @maxeckel in https://github.com/marmeon/marmeon/pull/442
- Keep a reset link when the password cannot be hashed, and refuse to write outside the project by @maxeckel in https://github.com/marmeon/marmeon/pull/443
- Name a test database by its process, so two test files never share one by @maxeckel in https://github.com/marmeon/marmeon/pull/449
- Let the newer visit win when an older one's view is still loading by @maxeckel in https://github.com/marmeon/marmeon/pull/450
- Roll back a Postgres transaction whose failed statement was caught inside it by @maxeckel in https://github.com/marmeon/marmeon/pull/451
- Keep answers of a session out of shared caches by @maxeckel in https://github.com/marmeon/marmeon/pull/453
- Keep the page and its input when a form gets an answer that is no page by @maxeckel in https://github.com/marmeon/marmeon/pull/454
- Hold a job this worker cannot decrypt, and say when an old key may go by @maxeckel in https://github.com/marmeon/marmeon/pull/457
- Keep a log call's context from overwriting the framework's fields by @maxeckel in https://github.com/marmeon/marmeon/pull/460
- Let uploads past the nginx template's body limit by @maxeckel in https://github.com/marmeon/marmeon/pull/461
- Cap the input and errors a failed form flashes into the session by @maxeckel in https://github.com/marmeon/marmeon/pull/464
- Keep negative decimals numbers in a CSV export, and freeze the export in a fixture by @maxeckel in https://github.com/marmeon/marmeon/pull/462
- Answer a new build's 409 with a local location that no cache keeps by @maxeckel in https://github.com/marmeon/marmeon/pull/463
- Stop listing API tokens with the new recovery codes by @maxeckel in https://github.com/marmeon/marmeon/pull/468

### Documentation

- Say which other surfaces are public API by @maxeckel in https://github.com/marmeon/marmeon/pull/395
- Show a webhook endpoint as a recipe by @maxeckel in https://github.com/marmeon/marmeon/pull/404
- Say which more surfaces are API, and fix the docs the audits found by @maxeckel in https://github.com/marmeon/marmeon/pull/446
- Say what every export is for by @maxeckel in https://github.com/marmeon/marmeon/pull/447
- Say which more promises 1.0 makes, and which interfaces an app is only given by @maxeckel in https://github.com/marmeon/marmeon/pull/465
- Fix the docs the third audit found wrong or missing by @maxeckel in https://github.com/marmeon/marmeon/pull/466
- Say which variables the tracing SDK leaves unread by @maxeckel in https://github.com/marmeon/marmeon/pull/478

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.4.0...v1.0.0-rc.1

## 0.4.0

### Breaking changes

- Return a curated PageInfo from usePage() instead of the page object by @maxeckel in https://github.com/marmeon/marmeon/pull/129
- Type the schemas of the framework's queued payloads as Standard Schema by @maxeckel in https://github.com/marmeon/marmeon/pull/131
- Keep Hono and Pino out of the public types by @maxeckel in https://github.com/marmeon/marmeon/pull/132
- Move the database's internals to @marmeon/database/internal by @maxeckel in https://github.com/marmeon/marmeon/pull/133
- Move the core's internals to @marmeon/core/internal and its test doubles to /testing by @maxeckel in https://github.com/marmeon/marmeon/pull/134
- Move the internals of the router and http's server entry to their internal subpaths by @maxeckel in https://github.com/marmeon/marmeon/pull/136
- Move the internals of queue, cache, storage, scheduler, session, redis, encryption and log, and their fakes to /testing by @maxeckel in https://github.com/marmeon/marmeon/pull/137
- Move the internals of server, vite, cli, devtools, live and otel to internal subpaths by @maxeckel in https://github.com/marmeon/marmeon/pull/138
- Move the internals of auth, mail, notifications, i18n, validation, table and testing, and their fakes to /testing by @maxeckel in https://github.com/marmeon/marmeon/pull/139
- Define the WebAuthn JSON types in @marmeon/auth by @maxeckel in https://github.com/marmeon/marmeon/pull/140
- Separate the app's definition from the options that boot it by @maxeckel in https://github.com/marmeon/marmeon/pull/141
- Give the page protocol its own entry @marmeon/http/protocol by @maxeckel in https://github.com/marmeon/marmeon/pull/145
- Name the query builder's types in @marmeon/database by @maxeckel in https://github.com/marmeon/marmeon/pull/147
- Keep the Vite plugin's entries object internal by @maxeckel in https://github.com/marmeon/marmeon/pull/157
- Mark devtools, live, otel, table and tinker as experimental by @maxeckel in https://github.com/marmeon/marmeon/pull/148
- Refuse builder methods and statements the database's guards do not know by @maxeckel in https://github.com/marmeon/marmeon/pull/152
- Split the cache's locks into LockStore and let packages and apps bring their own cache drivers by @maxeckel in https://github.com/marmeon/marmeon/pull/156
- Stop exporting the built-in disk drivers by @maxeckel in https://github.com/marmeon/marmeon/pull/161
- Move the client's adapter interface to @marmeon/http/client/adapter by @maxeckel in https://github.com/marmeon/marmeon/pull/155
- Export only the app's API from @marmeon/react; visit() and reload() return PageInfo by @maxeckel in https://github.com/marmeon/marmeon/pull/158
- Pass PageInfo, not the page object, to visit callbacks and events by @maxeckel in https://github.com/marmeon/marmeon/pull/160
- Trim the client entries of devtools and table, and move the test doubles of devtools and live to /testing by @maxeckel in https://github.com/marmeon/marmeon/pull/163
- Mark ResolvePage.features experimental by @maxeckel in https://github.com/marmeon/marmeon/pull/166
- Write the migrations an upgrade needs with make:upgrade-migrations, and check the framework's tables in readiness by @maxeckel in https://github.com/marmeon/marmeon/pull/170
- Prefix the session and remember-me cookies with __Host- when they are secure by @maxeckel in https://github.com/marmeon/marmeon/pull/172
- Mark the generated route and database types with their format by @maxeckel in https://github.com/marmeon/marmeon/pull/173
- Exit with 2 when a command is called wrongly by @maxeckel in https://github.com/marmeon/marmeon/pull/178
- Version the queue's job record and hold jobs a worker cannot read until one can by @maxeckel in https://github.com/marmeon/marmeon/pull/177
- Version the page protocol and answer other versions with 409 before any controller runs by @maxeckel in https://github.com/marmeon/marmeon/pull/181
- Mark the session payload with its format and leave sessions of an unknown format untouched by @maxeckel in https://github.com/marmeon/marmeon/pull/179
- Find queued listeners by a stable static listener name by @maxeckel in https://github.com/marmeon/marmeon/pull/180
- Move the migrator's bookkeeping to marmeon_ tables with a version and refuse queries on bookkeeping it cannot read by @maxeckel in https://github.com/marmeon/marmeon/pull/188
- Rename the queue's tables to marmeon_jobs and marmeon_failed_jobs by @maxeckel in https://github.com/marmeon/marmeon/pull/189
- Rename the tables of the cache and the sessions to marmeon_cache, marmeon_cache_locks and marmeon_sessions by @maxeckel in https://github.com/marmeon/marmeon/pull/191
- Rename the tables of temporary uploads and notifications to marmeon_temporary_uploads and marmeon_notifications by @maxeckel in https://github.com/marmeon/marmeon/pull/192
- Rename the starter kit's auth tables to marmeon_ by @maxeckel in https://github.com/marmeon/marmeon/pull/193
- Issue API tokens without their row id and find them by their hash by @maxeckel in https://github.com/marmeon/marmeon/pull/194
- Declare a migration as a plan that migrate runs, with data changes as steps of their own by @maxeckel in https://github.com/marmeon/marmeon/pull/202
- Compute the schema the migrations describe from their plans, without a database by @maxeckel in https://github.com/marmeon/marmeon/pull/204
- Generate the table types from the migrations without a database, and describe each table's keys and marks in them by @maxeckel in https://github.com/marmeon/marmeon/pull/206
- Read the schema from the projection of the migrations and refuse queries while migrations are pending by @maxeckel in https://github.com/marmeon/marmeon/pull/208
- Spell out selectAll and returningAll as the columns the migrations know, for every table by @maxeckel in https://github.com/marmeon/marmeon/pull/209
- Keep only migrations and migration_lock in the database, and check the database against the migrations after every migration by @maxeckel in https://github.com/marmeon/marmeon/pull/210
- Require the user provider methods that end sessions, and a password write that says whether it wrote by @maxeckel in https://github.com/marmeon/marmeon/pull/215
- Keep remember-me tokens on the sign-in rows by @maxeckel in https://github.com/marmeon/marmeon/pull/216
- Bind a session to the account's id and session key, so that a rehash keeps every sign-in by @maxeckel in https://github.com/marmeon/marmeon/pull/217
- Make the auth stores abstract classes that require every security-relevant method, typed by the app's user id by @maxeckel in https://github.com/marmeon/marmeon/pull/218
- Make SessionStore an abstract class that every session store extends by @maxeckel in https://github.com/marmeon/marmeon/pull/220
- Make sign-ins part of every app and drop the remember_tokens table by @maxeckel in https://github.com/marmeon/marmeon/pull/221
- Check a signed-in user's password only under its throttle by @maxeckel in https://github.com/marmeon/marmeon/pull/224
- Limit password sign-ins per client and per account inside Auth.attempt() by @maxeckel in https://github.com/marmeon/marmeon/pull/227
- Ship auth:end-sessions and auth:reset-two-factor with @marmeon/auth by @maxeckel in https://github.com/marmeon/marmeon/pull/230
- Move the starter kit's change of address onto EmailChange and its own table by @maxeckel in https://github.com/marmeon/marmeon/pull/232
- Refuse migrations that a module reads from node_modules by @maxeckel in https://github.com/marmeon/marmeon/pull/235
- Remove make:upgrade-migrations and the revisions of the framework's tables by @maxeckel in https://github.com/marmeon/marmeon/pull/245
- Let marmeon publish read the migrations of a package from its service provider by @maxeckel in https://github.com/marmeon/marmeon/pull/257
- Record a checksum of every migration that runs by @maxeckel in https://github.com/marmeon/marmeon/pull/258
- Allow the migrations of a module only from a real path in the app or its workspace by @maxeckel in https://github.com/marmeon/marmeon/pull/261
- Pass the status and headers of a page or JSON result as options by @maxeckel in https://github.com/marmeon/marmeon/pull/290
- Pass the route parameters of useForm as an option by @maxeckel in https://github.com/marmeon/marmeon/pull/295
- Refuse a middleware extension that would replace a key of the request context by @maxeckel in https://github.com/marmeon/marmeon/pull/294
- Rename the environment variables of the database, the queue and mail by @maxeckel in https://github.com/marmeon/marmeon/pull/292
- Name the units of the auth variables and read their switches as booleans by @maxeckel in https://github.com/marmeon/marmeon/pull/293
- Name the units of the session, upload and live variables by @maxeckel in https://github.com/marmeon/marmeon/pull/296
- Prefix the server's variables with SERVER_ and Marmeon's own OpenTelemetry variables with MARMEON_OTEL_ by @maxeckel in https://github.com/marmeon/marmeon/pull/299
- Report errors through error reporters that providers bring by @maxeckel in https://github.com/marmeon/marmeon/pull/303
- Document the package protocol and refuse unknown keys in the "marmeon" field by @maxeckel in https://github.com/marmeon/marmeon/pull/305
- Name the auth events after signing in by @maxeckel in https://github.com/marmeon/marmeon/pull/300
- Rename UserProvider.findForLogin() to findForSignIn() by @maxeckel in https://github.com/marmeon/marmeon/pull/318
- Require REDIS_PREFIX or APP_NAME instead of defaulting the Redis prefix to "marmeon" by @maxeckel in https://github.com/marmeon/marmeon/pull/319
- Require DB_DATABASE or a DB_URL with a database name instead of defaulting the Postgres database to "marmeon" by @maxeckel in https://github.com/marmeon/marmeon/pull/322
- Require the extension in next() when any member of a union adds keys by @maxeckel in https://github.com/marmeon/marmeon/pull/323

### Features

- Let a test file share one Vite server across its server-rendered test apps by @maxeckel in https://github.com/marmeon/marmeon/pull/111
- Add deprecated() to warn once when a deprecated API is used by @maxeckel in https://github.com/marmeon/marmeon/pull/121
- Forbid importing @marmeon/*/internal in the generated lint config by @maxeckel in https://github.com/marmeon/marmeon/pull/125
- Let packages and apps bring their own queue drivers and failed-job stores by @maxeckel in https://github.com/marmeon/marmeon/pull/144
- Mark whole entries, options and commands as experimental in the API snapshot by @maxeckel in https://github.com/marmeon/marmeon/pull/143
- Let packages and apps bring their own disk drivers by @maxeckel in https://github.com/marmeon/marmeon/pull/149
- Make the message types of the diagnostics channels stable by @maxeckel in https://github.com/marmeon/marmeon/pull/165
- Give server errors stable codes and show each code with its solution by @maxeckel in https://github.com/marmeon/marmeon/pull/175
- Print route:list and list as JSON with a format marker by @maxeckel in https://github.com/marmeon/marmeon/pull/176
- Let only one migration run at a time by @maxeckel in https://github.com/marmeon/marmeon/pull/174
- Give the route, request and command errors their codes by @maxeckel in https://github.com/marmeon/marmeon/pull/182
- Add marmeon check with the type check, the lint and a check for imports of framework internals by @maxeckel in https://github.com/marmeon/marmeon/pull/184
- Give the database's guard, connection, resolver and seeder errors their codes by @maxeckel in https://github.com/marmeon/marmeon/pull/185
- Give the setup errors of auth, sessions, queues and services their codes by @maxeckel in https://github.com/marmeon/marmeon/pull/186
- Print schedule:list and db:show as JSON by @maxeckel in https://github.com/marmeon/marmeon/pull/187
- Let packages add checks to marmeon check, and check route types, database types, modules, the boot and readiness by @maxeckel in https://github.com/marmeon/marmeon/pull/190
- Write the development server's last error to .marmeon/last-error.md by @maxeckel in https://github.com/marmeon/marmeon/pull/196
- Print migrate:status as JSON by @maxeckel in https://github.com/marmeon/marmeon/pull/198
- Give the errors of migrations and stored formats their codes, and check the upgrade migrations by @maxeckel in https://github.com/marmeon/marmeon/pull/199
- Let alter make a column NOT NULL or nullable on Postgres by @maxeckel in https://github.com/marmeon/marmeon/pull/203
- Keep the schema projection in .marmeon/schema.json, checked against every migration file by @maxeckel in https://github.com/marmeon/marmeon/pull/205
- Type tables Marmeon does not know on a module's database with withTables, for reading only by @maxeckel in https://github.com/marmeon/marmeon/pull/207
- Read the migration files again in the development server when one is added, changed or removed by @maxeckel in https://github.com/marmeon/marmeon/pull/211
- Take a column out of use with retire() one release before dropping it by @maxeckel in https://github.com/marmeon/marmeon/pull/213
- Add securityHeaders() to @marmeon/http and use it in new apps by @maxeckel in https://github.com/marmeon/marmeon/pull/214
- Write password hashes and session keys with the statements of @marmeon/auth by @maxeckel in https://github.com/marmeon/marmeon/pull/219
- Add EmailChangeStore, kept in an email_changes table by @maxeckel in https://github.com/marmeon/marmeon/pull/225
- Add EmailChange: a change of address with a fresh factor, a throttled password and a single-use link by @maxeckel in https://github.com/marmeon/marmeon/pull/226
- Define the rate limits of the auth routes in @marmeon/auth and limit every guest POST of the starter kit by @maxeckel in https://github.com/marmeon/marmeon/pull/229
- Ship the browser side of passkeys as @marmeon/auth/passkeys/browser by @maxeckel in https://github.com/marmeon/marmeon/pull/231
- Record the files make:auth copies, with their version and hash, in marmeon-stubs.json by @maxeckel in https://github.com/marmeon/marmeon/pull/234
- Record the template files of a new app in marmeon-stubs.json by @maxeckel in https://github.com/marmeon/marmeon/pull/236
- Add marmeon agents:sync, which keeps a block of AGENTS.md in step with the installed version by @maxeckel in https://github.com/marmeon/marmeon/pull/237
- Export SchemaRequirements from @marmeon/database by @maxeckel in https://github.com/marmeon/marmeon/pull/238
- Give every new app an AGENTS.md and a CLAUDE.md by @maxeckel in https://github.com/marmeon/marmeon/pull/239
- Declare the migrations a package ships in package.json under marmeon.migrations by @maxeckel in https://github.com/marmeon/marmeon/pull/240
- Warn in marmeon check when the block of AGENTS.md is out of date by @maxeckel in https://github.com/marmeon/marmeon/pull/241
- Add marmeon publish, which copies the migrations of a package into the app by @maxeckel in https://github.com/marmeon/marmeon/pull/242
- Let a console command ask on a terminal, and never without one by @maxeckel in https://github.com/marmeon/marmeon/pull/246
- Declare the migrations of a package as a directory in package.json by @maxeckel in https://github.com/marmeon/marmeon/pull/253
- Let marmeon publish offer what each package lacks, check it and refuse a gap by @maxeckel in https://github.com/marmeon/marmeon/pull/250
- Let the make:*-table commands write every migration of their package by @maxeckel in https://github.com/marmeon/marmeon/pull/251
- Let a service provider declare the migrations its package ships by @maxeckel in https://github.com/marmeon/marmeon/pull/256
- Warn in migrate and migrate:status when a migration changed after it ran by @maxeckel in https://github.com/marmeon/marmeon/pull/260
- Report sql.raw() and sql.lit() with a non-literal argument in marmeon check, silenced only by a comment with a reason by @maxeckel in https://github.com/marmeon/marmeon/pull/263
- Report HTML set from a non-literal value in marmeon check by @maxeckel in https://github.com/marmeon/marmeon/pull/268
- Report changing routes that everyone may call and nothing limits in marmeon check by @maxeckel in https://github.com/marmeon/marmeon/pull/272
- Show in route:list which routes make records public by @maxeckel in https://github.com/marmeon/marmeon/pull/273
- Ship the documentation of the installed version in the marmeon package by @maxeckel in https://github.com/marmeon/marmeon/pull/266
- Add marmeon docs to list and print the pages of the installed version by @maxeckel in https://github.com/marmeon/marmeon/pull/267
- Add make:policy, which writes a policy that allows the owner of a record only by @maxeckel in https://github.com/marmeon/marmeon/pull/262
- Add make:test, which writes a test of a module against the booted app by @maxeckel in https://github.com/marmeon/marmeon/pull/265
- Add make:resource, which writes a module with its table, policy, requests, controllers, pages and test by @maxeckel in https://github.com/marmeon/marmeon/pull/270
- Point the agents block at the documentation of the installed version by @maxeckel in https://github.com/marmeon/marmeon/pull/275
- Report a missing HSTS header in marmeon check when production runs on an https APP_URL by @maxeckel in https://github.com/marmeon/marmeon/pull/278
- Point the agents block at the recipes by @maxeckel in https://github.com/marmeon/marmeon/pull/288
- Stop the start when a renamed environment variable is set by @maxeckel in https://github.com/marmeon/marmeon/pull/291
- Warn when mail is sent from the default address outside development by @maxeckel in https://github.com/marmeon/marmeon/pull/301
- List every environment variable on one page and check the naming rules by @maxeckel in https://github.com/marmeon/marmeon/pull/302
- Report failed jobs, scheduled tasks and commands to the error reporters by @maxeckel in https://github.com/marmeon/marmeon/pull/306
- Report errors of deferred groups, after-response work and terminate hooks to the error reporters by @maxeckel in https://github.com/marmeon/marmeon/pull/321

### Fixes

- Check the statement that runs after a query's own plugins by @maxeckel in https://github.com/marmeon/marmeon/pull/153
- Keep TestApp's constructor out of the public API by @maxeckel in https://github.com/marmeon/marmeon/pull/164
- Order migrations by code point by @maxeckel in https://github.com/marmeon/marmeon/pull/171
- Send log lines to stderr while a command prints JSON by @maxeckel in https://github.com/marmeon/marmeon/pull/183
- Refuse to construct an abstract store when nothing is bound to it by @maxeckel in https://github.com/marmeon/marmeon/pull/223
- End the other sessions when a passkey is removed, and every session when one looks copied by @maxeckel in https://github.com/marmeon/marmeon/pull/228
- Keep the migrations an app has when make:auth --force writes the auth module again by @maxeckel in https://github.com/marmeon/marmeon/pull/259
- Mask sensitive route parameters on the development error page, in last-error.md and in the devtools by the route's pattern by @maxeckel in https://github.com/marmeon/marmeon/pull/264
- Write last-error.md only for requests to a host the development routes answer by @maxeckel in https://github.com/marmeon/marmeon/pull/269
- Mask route parameters in Location and Referer headers by the matched route's pattern by @maxeckel in https://github.com/marmeon/marmeon/pull/274
- Mask passwords that contain @ or / in URLs by @maxeckel in https://github.com/marmeon/marmeon/pull/271
- Answer every unmatched path under /_marmeon/ with 404 before the app's routes by @maxeckel in https://github.com/marmeon/marmeon/pull/276
- Let marmeon docs end quietly when the reader closes the pipe by @maxeckel in https://github.com/marmeon/marmeon/pull/277
- Show the app's node_modules path in marmeon docs from a subfolder by @maxeckel in https://github.com/marmeon/marmeon/pull/280
- Show the host of a redirect to another site in the devtools and error reports by @maxeckel in https://github.com/marmeon/marmeon/pull/282
- Match a route constraint with alternatives as a whole by @maxeckel in https://github.com/marmeon/marmeon/pull/285
- Mask bare tokens in text that names no key by @maxeckel in https://github.com/marmeon/marmeon/pull/304
- Keep a dependency's entry files inside its package by @maxeckel in https://github.com/marmeon/marmeon/pull/307
- Order live-stream sign-in checks and account ends on a monotonic clock by @maxeckel in https://github.com/marmeon/marmeon/pull/310
- Keep the type declarations of a dependency inside its package by @maxeckel in https://github.com/marmeon/marmeon/pull/316
- Close a test app that is ready only after its test ended by @maxeckel in https://github.com/marmeon/marmeon/pull/325
- Compare the work of a sign-up with a taken and a free address in the starter kit's test, not its time by @maxeckel in https://github.com/marmeon/marmeon/pull/326
- Keep the modules comment in bootstrap/app.ts true after make:auth by @maxeckel in https://github.com/marmeon/marmeon/pull/329
- Write the routes file of a new module without an unused parameter by @maxeckel in https://github.com/marmeon/marmeon/pull/330
- Prove equal work in the starter kit's email-change test instead of measuring it by @maxeckel in https://github.com/marmeon/marmeon/pull/313
- Let an untyped middleware pass where a pipeline takes any middleware by @maxeckel in https://github.com/marmeon/marmeon/pull/315

### Documentation

- Define what counts as public API and how unions grow and deprecations work by @maxeckel in https://github.com/marmeon/marmeon/pull/118
- State which versions get fixes and which platforms are supported by @maxeckel in https://github.com/marmeon/marmeon/pull/119
- Document the stored and wire formats, the upgrade that stops every process, and how a mixed fleet behaves by @maxeckel in https://github.com/marmeon/marmeon/pull/197
- Explain in one place how the app knows its schema, and how to deploy new migrations by @maxeckel in https://github.com/marmeon/marmeon/pull/212
- Document what an app implements for authentication by @maxeckel in https://github.com/marmeon/marmeon/pull/222
- Document what @marmeon/auth decides and what the starter kit wires by @maxeckel in https://github.com/marmeon/marmeon/pull/233
- Document the tables a package brings and what a new app gives coding agents by @maxeckel in https://github.com/marmeon/marmeon/pull/243
- Document that the migrations of a package are append-only by @maxeckel in https://github.com/marmeon/marmeon/pull/252
- Add a recipe for a resource with its policy, checked against a starter-kit app by @maxeckel in https://github.com/marmeon/marmeon/pull/279
- Add a recipe for a public page and a form that guests may send by @maxeckel in https://github.com/marmeon/marmeon/pull/283
- Serve the docs of each release line under /docs/&lt;line>/ with its own llms.txt by @maxeckel in https://github.com/marmeon/marmeon/pull/284
- Add a recipe for a background job that retries by @maxeckel in https://github.com/marmeon/marmeon/pull/287
- Build the notes app of Your First App with make:resource by @maxeckel in https://github.com/marmeon/marmeon/pull/289
- Document the filter, page and export kinds of tables as open by @maxeckel in https://github.com/marmeon/marmeon/pull/297
- Fix the helpers of the Controller base class by @maxeckel in https://github.com/marmeon/marmeon/pull/298
- Say what a release candidate promises on the release policy page by @maxeckel in https://github.com/marmeon/marmeon/pull/308
- List every authentication event and which ones can be queued by @maxeckel in https://github.com/marmeon/marmeon/pull/311
- Close the gaps an outside trial found in the routing, authorization, migration and deployment docs by @maxeckel in https://github.com/marmeon/marmeon/pull/331
- Add a recipe for bookings that never overlap by @maxeckel in https://github.com/marmeon/marmeon/pull/332

### New contributors

- @dependabot[bot] made their first contribution in https://github.com/marmeon/marmeon/pull/102

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v0.3.0...v0.4.0

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

### Patch Changes

- @marmeon/http@0.1.2
  - @marmeon/i18n@0.1.2
  - @marmeon/table@0.1.2

## 0.1.1

### Patch Changes

- f56608b: Publish every package through the release workflow, with npm provenance.
- Updated dependencies [f56608b]
  - @marmeon/http@0.1.1
  - @marmeon/i18n@0.1.1
  - @marmeon/table@0.1.1

## 0.1.0

### Minor Changes

- The first release (0.1.0): every package of the framework — the application kernel with constructor injection, the router, the
  page protocol and the React adapter, sessions, auth, the data layer, mail, queues, the scheduler, storage, live props, i18n, the
  devtools and OpenTelemetry — together with `create-marmeon`, all at one version.

### Patch Changes

- Updated dependencies
  - @marmeon/http@0.1.0
  - @marmeon/i18n@0.1.0
  - @marmeon/table@0.1.0

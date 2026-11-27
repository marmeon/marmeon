# @marmeon/oauth
## 1.3.0

### Features

- Let a provider register jobs with static [providerJobs] by @maxeckel in https://github.com/marmeon/marmeon/pull/892
- Add r.string().wellFormed() to refuse lone surrogates by @maxeckel in https://github.com/marmeon/marmeon/pull/893
- Let a disk open one range of a file by @maxeckel in https://github.com/marmeon/marmeon/pull/908
- Document sources of a package in an app's workspace by @maxeckel in https://github.com/marmeon/marmeon/pull/900
- Stamp a new migration behind those of every module by @maxeckel in https://github.com/marmeon/marmeon/pull/903
- Open ranges on S3 disks by @maxeckel in https://github.com/marmeon/marmeon/pull/909
- Answer Range requests for files of a disk by @maxeckel in https://github.com/marmeon/marmeon/pull/910
- Share one instance of a workspace package in an app's tests by @maxeckel in https://github.com/marmeon/marmeon/pull/899
- List the jobs of providers in modules:list and the app overview by @maxeckel in https://github.com/marmeon/marmeon/pull/929
- Serve the default locale without a prefix when APP_LOCALE_PREFIX is false by @maxeckel in https://github.com/marmeon/marmeon/pull/945

### Fixes

- Count a provider's jobs as listed in modules:check, check and tinker by @maxeckel in https://github.com/marmeon/marmeon/pull/894
- Warn when the sync connection ignores a delay by @maxeckel in https://github.com/marmeon/marmeon/pull/895
- Warn when a scheduled job's name belongs to another class by @maxeckel in https://github.com/marmeon/marmeon/pull/898
- Name a name that Postgres cut as the cause of D3 by @maxeckel in https://github.com/marmeon/marmeon/pull/896
- Name the copy under node_modules when type stripping refuses a source by @maxeckel in https://github.com/marmeon/marmeon/pull/897
- Warn about a second copy of a framework package in one version by @maxeckel in https://github.com/marmeon/marmeon/pull/902
- Free a unique job's lock when its dispatch fails before the job exists by @maxeckel in https://github.com/marmeon/marmeon/pull/914
- Refuse a NUL character in password() by @maxeckel in https://github.com/marmeon/marmeon/pull/915
- Refuse a cookie value with half of a surrogate pair when it is set by @maxeckel in https://github.com/marmeon/marmeon/pull/916
- Find tinker's db, jobs, mail, repos and sandbox by their package's class by @maxeckel in https://github.com/marmeon/marmeon/pull/918
- Exit schedule:work with its code when a run hangs at the stop by @maxeckel in https://github.com/marmeon/marmeon/pull/919
- Refuse a response status outside 200 to 599 in json() and view() by @maxeckel in https://github.com/marmeon/marmeon/pull/920
- Treat a job as encrypted wherever its payload is encrypted by @maxeckel in https://github.com/marmeon/marmeon/pull/922
- Discover again when a package of the app's workspace changes its package.json by @maxeckel in https://github.com/marmeon/marmeon/pull/927
- End a thief's sessions before logging the theft by @maxeckel in https://github.com/marmeon/marmeon/pull/935
- Ask Postgres whether a migration's index and constraint names fit by @maxeckel in https://github.com/marmeon/marmeon/pull/930
- Answer claimedBy() in a command as in a request by @maxeckel in https://github.com/marmeon/marmeon/pull/942
- Name a dispatched job apart from the job that is running in queue log lines by @maxeckel in https://github.com/marmeon/marmeon/pull/923
- Find the injection list of a class a package imports and exports again by @maxeckel in https://github.com/marmeon/marmeon/pull/926
- Look for an app's packages only up to its workspace by @maxeckel in https://github.com/marmeon/marmeon/pull/936
- Refuse a NUL character in a table's search and row keys by @maxeckel in https://github.com/marmeon/marmeon/pull/932
- Refuse an upload name with a NUL character and cut it by code points by @maxeckel in https://github.com/marmeon/marmeon/pull/933
- Refuse to drop or rename a table or column by a name Postgres would cut by @maxeckel in https://github.com/marmeon/marmeon/pull/931
- Refuse a job key that names the lock of another job, and warn at queue:work start by @maxeckel in https://github.com/marmeon/marmeon/pull/924
- Name the package of a provider that is no class at boot by @maxeckel in https://github.com/marmeon/marmeon/pull/939
- Keep a failed log write from throwing or hanging the process by @maxeckel in https://github.com/marmeon/marmeon/pull/941
- Keep a failing log sink from changing how auth's failure paths end by @maxeckel in https://github.com/marmeon/marmeon/pull/944
- Emit JobFailed even when the logger's error() rejects by @maxeckel in https://github.com/marmeon/marmeon/pull/938
- Stop the database's lockfile search at the last trusted folder above the app by @maxeckel in https://github.com/marmeon/marmeon/pull/943
- Refuse a tinker sandbox when a second copy of the database package is installed by @maxeckel in https://github.com/marmeon/marmeon/pull/937
- Refuse a table name with a dot in schema.create() and schema.rename() by @maxeckel in https://github.com/marmeon/marmeon/pull/934
- Update dependencies and raise the vite peer floor to 8.3.6 by @maxeckel in https://github.com/marmeon/marmeon/pull/947
- Update Kysely to 0.29.9 and keep its aborted-commit error inside the driver by @maxeckel in https://github.com/marmeon/marmeon/pull/948
- Refuse a statement that reaches a transaction's connection after its commit or rollback by @maxeckel in https://github.com/marmeon/marmeon/pull/949

### Documentation

- Say when pnpm installs a framework package twice by @maxeckel in https://github.com/marmeon/marmeon/pull/901
- Show how to test a generated migration by @maxeckel in https://github.com/marmeon/marmeon/pull/904
- Show generators how a data step holds its content by @maxeckel in https://github.com/marmeon/marmeon/pull/905
- Say that a Response with a body serves one request by @maxeckel in https://github.com/marmeon/marmeon/pull/917
- Say that a logger handles the failures of its own writes by @maxeckel in https://github.com/marmeon/marmeon/pull/925
- Say which newest migration stamps are refused by @maxeckel in https://github.com/marmeon/marmeon/pull/940
- Make package development a docs section of its own by @maxeckel in https://github.com/marmeon/marmeon/pull/946

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v1.2.3...v1.3.0

## 1.2.3

### Fixes

- Hold a response to its Content-Length on startServer and refuse a fetched Response by @maxeckel in https://github.com/marmeon/marmeon/security/advisories/GHSA-mxg6-hmhw-47gq

### Documentation

- Count the layers of the chain in the hero stats, not its typos by @maxeckel in https://github.com/marmeon/marmeon/pull/889

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v1.2.2...v1.2.3

## 1.2.2

### Features

- Give coding agents a database's tables and row counts through marmeon mcp by @maxeckel in https://github.com/marmeon/marmeon/pull/772
- Publish browser reports from the dev server on a browser.log channel by @maxeckel in https://github.com/marmeon/marmeon/pull/775
- Record browser reports as devtools entries by @maxeckel in https://github.com/marmeon/marmeon/pull/777
- Give coding agents the app's commands and their options through marmeon mcp by @maxeckel in https://github.com/marmeon/marmeon/pull/774
- Send a page's console errors, uncaught errors and rejections to the devtools by @maxeckel in https://github.com/marmeon/marmeon/pull/779
- Tell coding agents the Node version and which environment variables the app reads by @maxeckel in https://github.com/marmeon/marmeon/pull/776
- Add marmeon db:query to run one read-only query against a connection by @maxeckel in https://github.com/marmeon/marmeon/pull/780
- Give coding agents one read-only SQL query through marmeon mcp by @maxeckel in https://github.com/marmeon/marmeon/pull/781
- Teach the debugging skill the query tool and tinker --sandbox by @maxeckel in https://github.com/marmeon/marmeon/pull/782
- Teach the debugging skill the database and commands tools, browser entries and the app's environment by @maxeckel in https://github.com/marmeon/marmeon/pull/783
- List a sitemap entry's versions in other languages by @maxeckel in https://github.com/marmeon/marmeon/pull/784
- Add a path parameter that takes the rest of the path by @maxeckel in https://github.com/marmeon/marmeon/pull/785
- Warn when two routes answer the same method and path by @maxeckel in https://github.com/marmeon/marmeon/pull/786
- Answer every path no route takes with Route.fallback() by @maxeckel in https://github.com/marmeon/marmeon/pull/787
- Ask the router whether a path is taken with claimedBy() by @maxeckel in https://github.com/marmeon/marmeon/pull/788
- Put a fallback under the visitor's locale with Route.localized().fallback() by @maxeckel in https://github.com/marmeon/marmeon/pull/789
- Give each language version of a page its own parameters by @maxeckel in https://github.com/marmeon/marmeon/pull/790
- Let a package declare its namespace, pages, entry and texts by @maxeckel in https://github.com/marmeon/marmeon/pull/792
- Bundle a package's pages and components with the app's Vite by @maxeckel in https://github.com/marmeon/marmeon/pull/794
- Type and resolve a package's pages as `ns::View` by @maxeckel in https://github.com/marmeon/marmeon/pull/793
- Build every entry in one client build without sharing first-load code by @maxeckel in https://github.com/marmeon/marmeon/pull/795
- Load a package's texts on the server and let the app reword them by @maxeckel in https://github.com/marmeon/marmeon/pull/797
- Render a package's pages in a document of their own by @maxeckel in https://github.com/marmeon/marmeon/pull/798
- Send a package's texts to the browser of the entry that shows them by @maxeckel in https://github.com/marmeon/marmeon/pull/799
- Load the page fully when a visit crosses into another entry by @maxeckel in https://github.com/marmeon/marmeon/pull/800
- Give every document of a package entry a strict policy unless a route sets one by @maxeckel in https://github.com/marmeon/marmeon/pull/802
- Let a package register a guard on users of its own by @maxeckel in https://github.com/marmeon/marmeon/pull/809
- Protect a package guard's routes and refuse another guard's middleware by @maxeckel in https://github.com/marmeon/marmeon/pull/810
- Know a route's guard before its first middleware runs by @maxeckel in https://github.com/marmeon/marmeon/pull/812
- Offer two-factor authentication to a package guard by @maxeckel in https://github.com/marmeon/marmeon/pull/811
- Offer passkeys to a package guard by @maxeckel in https://github.com/marmeon/marmeon/pull/814
- Let a policy name the guard whose users it judges by @maxeckel in https://github.com/marmeon/marmeon/pull/815
- Drop loginRoute from a package guard's factor middleware by @maxeckel in https://github.com/marmeon/marmeon/pull/816
- Let the operator commands act on a package guard by @maxeckel in https://github.com/marmeon/marmeon/pull/818
- Let a package choose at boot whose users its policies and routes judge by @maxeckel in https://github.com/marmeon/marmeon/pull/819
- Sign in as a package guard's user in tests by @maxeckel in https://github.com/marmeon/marmeon/pull/821
- Give a package guard events of its own by @maxeckel in https://github.com/marmeon/marmeon/pull/822
- Give a guard slot events that follow its binding by @maxeckel in https://github.com/marmeon/marmeon/pull/825
- Refuse a guard slot whose listeners can never hear an event by @maxeckel in https://github.com/marmeon/marmeon/pull/826
- Tell from a guard's Auth whether the request's route is its own by @maxeckel in https://github.com/marmeon/marmeon/pull/834
- Refuse uploaded images whose header states too many pixels by @maxeckel in https://github.com/marmeon/marmeon/pull/839
- Report a package's migration that changed since the app published it by @maxeckel in https://github.com/marmeon/marmeon/pull/842
- Let a controller answer a stale save with a conflict that useAction reports by @maxeckel in https://github.com/marmeon/marmeon/pull/841
- Declare partial indexes in a migration's plan by @maxeckel in https://github.com/marmeon/marmeon/pull/844
- Add @marmeon/fetch: outgoing HTTP that refuses private addresses, with a fake for tests by @maxeckel in https://github.com/marmeon/marmeon/pull/840
- Bring a conflict back to useForm and Form after a stale save by @maxeckel in https://github.com/marmeon/marmeon/pull/843
- Give every new app @marmeon/fetch by @maxeckel in https://github.com/marmeon/marmeon/pull/846
- Add 'mysql' to Driver and ConnectionOptions by @maxeckel in https://github.com/marmeon/marmeon/pull/862
- Add marmeon doctor to check that a machine can run the app by @maxeckel in https://github.com/marmeon/marmeon/pull/855
- Report each migration that has not run in marmeon doctor by @maxeckel in https://github.com/marmeon/marmeon/pull/866
- Add marmeon add to install a framework package at the app's version by @maxeckel in https://github.com/marmeon/marmeon/pull/868
- Add marmeon upgrade to move every framework package to one version by @maxeckel in https://github.com/marmeon/marmeon/pull/870
- Point the framework's install hints at marmeon add by @maxeckel in https://github.com/marmeon/marmeon/pull/871
- Add @marmeon/oauth: providers, the flow, OpenID Connect and a test fake by @maxeckel in https://github.com/marmeon/marmeon/pull/863
- Add social accounts to @marmeon/oauth: sign in, register, link and confirm by @maxeckel in https://github.com/marmeon/marmeon/pull/864
- Generate the oauth module, show it in the web app, and publish @marmeon/oauth by @maxeckel in https://github.com/marmeon/marmeon/pull/873
- Add @marmeon/chat-notifications: Slack, Discord and Teams messages through incoming webhooks, with a fake for tests by @maxeckel in https://github.com/marmeon/marmeon/pull/872

### Fixes

- Keep the package default policy off the app's error page and warn on shared caching by @maxeckel in https://github.com/marmeon/marmeon/pull/803
- Expect A9 when a package guard's factor middleware runs before its sign-in by @maxeckel in https://github.com/marmeon/marmeon/pull/813
- Refuse a guard registered after the auth provider has booted by @maxeckel in https://github.com/marmeon/marmeon/pull/823
- Let credentialWriter() write the users of a package guard by @maxeckel in https://github.com/marmeon/marmeon/pull/828
- Make "Done" on the recovery codes a link that works without JavaScript by @maxeckel in https://github.com/marmeon/marmeon/pull/833
- Keep the page a guest wanted per guard by @maxeckel in https://github.com/marmeon/marmeon/pull/836
- Refuse retiring a fixed-default column unless no unique index can collide on it by @maxeckel in https://github.com/marmeon/marmeon/pull/847
- Keep a refused form's errors and input for the page of its own submit by @maxeckel in https://github.com/marmeon/marmeon/pull/850
- Refuse a database driver a package has no SQL for by @maxeckel in https://github.com/marmeon/marmeon/pull/858
- Close the pool of a connection only the migrator or an inspection opened by @maxeckel in https://github.com/marmeon/marmeon/pull/878
- Run migrations on MySQL by @maxeckel in https://github.com/marmeon/marmeon/pull/876
- Mask code and state wherever the redactor shows a query by @maxeckel in https://github.com/marmeon/marmeon/pull/856
- Answer 404 before a lab route's own limit counts by @maxeckel in https://github.com/marmeon/marmeon/pull/879
- Throw when an optional package of createTestApp is installed but does not load by @maxeckel in https://github.com/marmeon/marmeon/pull/880
- Load the chat package through importOptional, like the other optional packages by @maxeckel in https://github.com/marmeon/marmeon/pull/882
- Load @marmeon/auth before the boot and close what runs when createTestApp fails after it by @maxeckel in https://github.com/marmeon/marmeon/pull/883
- Load @marmeon/storage without its optional peer @marmeon/database by @maxeckel in https://github.com/marmeon/marmeon/pull/884

### Documentation

- Show the OpenSSF Best Practices badge in the README by @maxeckel in https://github.com/marmeon/marmeon/pull/771
- Show a component of a package hydrating on an app page by @maxeckel in https://github.com/marmeon/marmeon/pull/801
- Show a package with its own area in the web app by @maxeckel in https://github.com/marmeon/marmeon/pull/804
- Drop the second copy of "Events of a guard slot" by @maxeckel in https://github.com/marmeon/marmeon/pull/827
- Show a package with a guard of its own in the web app by @maxeckel in https://github.com/marmeon/marmeon/pull/829
- Add two-factor sign-in and passkeys to the back office by @maxeckel in https://github.com/marmeon/marmeon/pull/830
- Move "A package with users of its own" to docs/package-users.md by @maxeckel in https://github.com/marmeon/marmeon/pull/831
- Rebuild the website in the Carved look, with a ⌘K docs search by @maxeckel in https://github.com/marmeon/marmeon/pull/845
- Open the landing's narrow menu as a full-screen sheet with groups to step into by @maxeckel in https://github.com/marmeon/marmeon/pull/852
- Say why the dimensions of an upload rule do not measure AVIF by @maxeckel in https://github.com/marmeon/marmeon/pull/849

**Full Changelog**: https://github.com/marmeon/marmeon/compare/v1.1.0...v1.2.2

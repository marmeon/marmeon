# @marmeon/chat-notifications
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

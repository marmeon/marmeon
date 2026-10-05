# Security policy

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, a pull request or a discussion. Use GitHub's **private vulnerability
reporting**: the repository's *Security* tab → *Report a vulnerability*
(<https://github.com/bespokecore/bespokecore/security/advisories/new>). Only the maintainers see the report.

Please include what you can of:

- the package and version (or commit), Node's version, the driver or configuration involved;
- what an attacker can do, and what they need for it (an account, a position on the network, a setting);
- the steps to reproduce it, ideally as a failing test or a small app.

What happens then:

- You hear back within **five working days** — that the report arrived and whether we can reproduce it.
- We work on the fix in a private fork of the advisory and keep you informed; you are welcome to review the fix.
- A fix is released for the supported versions (below), and the advisory is published with it — with credit to you, unless you
  ask us not to. A CVE is requested through GitHub where it applies.
- Please give us 90 days before you disclose anything yourself, or less once a fixed release is out.

## Supported versions

BespokeCore is in 0.x ([versions and deprecations](README.md#versions-and-deprecations)): security fixes are released for the
**latest minor version** only — upgrade along [UPGRADING.md](UPGRADING.md). From 1.0 on, the policy in the README names how long
each major version receives security fixes.

| Version | Security fixes |
|---|---|
| latest 0.x minor | yes |
| older 0.x | no — upgrade |

## What is in scope

The packages of this repository (`@bespokecore/*`, `bespokecore`, `create-bespoke-app`) and what they generate (`bespoke make:*`,
the starter kit). The demo apps under `apps/` are examples, not products — a flaw there is welcome as a normal issue unless it
lies in framework code they show.

The framework's security defaults are documented with the packages — sessions, CSRF and cookies in
[@bespokecore/session](packages/session/README.md), the Content-Security-Policy in [@bespokecore/http](packages/http/README.md),
authentication in [@bespokecore/auth](packages/auth/README.md), the production setup in [docs/deployment.md](docs/deployment.md).

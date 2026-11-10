# Security policy

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, a pull request or a discussion. Use GitHub's **private vulnerability
reporting**: the repository's *Security* tab → *Report a vulnerability*
(<https://github.com/marmeon/marmeon/security/advisories/new>). Only the maintainers see the report.

Without a GitHub account, or when GitHub is not an option, write to **<security@marmeon.com>** — only the maintainers read it,
too. The steps below are the same either way.

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

Security fixes are released for the **latest minor version of the current major version** (1.x). The previous major
version receives them for 12 months after the next major is released, as patches on its last minor version under the npm
dist-tag `latest-<major>`. 0.x receives none — upgrade along [Upgrading to 1.0.0 from
0.4.0](UPGRADING.md#upgrading-to-100-from-040) ([which versions get fixes](docs/releases.md#which-versions-get-fixes)).

| Version | Security fixes |
|---|---|
| 1.x, latest minor | yes |
| 1.x, older minors | no — upgrade to the latest minor |
| 0.x | no — upgrade to 1.0 |

## What is in scope

The packages of this repository (`@marmeon/*`, `marmeon`, `create-marmeon`) and what they generate (`marmeon make:*`,
the starter kit). The demo apps under `apps/` are examples, not products — a flaw there is welcome as a normal issue unless it
lies in framework code they show.

What an app protects by itself and what it leaves to you is summed up in [Security](docs/security.md); the details are on their
pages — [sessions](docs/session.md), [CSRF protection](docs/csrf.md), the [Content-Security-Policy](docs/csp.md),
[authentication](docs/authentication.md) and the production setup in [deployment](docs/deployment.md).

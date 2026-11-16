/** Where the website points outside itself and into the docs. Client-safe: no server imports. */
export const GITHUB_URL = 'https://github.com/marmeon/marmeon';
/** The release notes of a version: its GitHub Release page, found by the version's tag. */
export const releaseNotesUrl = (version: string) => `${GITHUB_URL}/releases/tag/v${version}`;
export const DISCORD_URL = 'https://discord.gg/Kv9hvscd9';
export const DISCUSSIONS_URL = `${GITHUB_URL}/discussions`;

export const COMPANY_NAME = 'BespokeCode UG (haftungsbeschränkt)';
export const COMPANY_URL = 'https://bespokecode.de';

export const DOCS_URL = '/docs';
/** The docs page "Get started" leads to: the header's button and the menu's feature link both name it. */
export const GET_STARTED_SLUG = 'installation';
export const PACKAGES_URL = '/docs/packages';
export const SECURITY_POLICY_URL = '/docs/security-policy';
export const RELEASE_POLICY_URL = '/docs/releases';
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

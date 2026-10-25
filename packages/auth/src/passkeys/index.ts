export { Passkeys } from './passkeys.ts';
export type { PasskeyError, PasskeySummary, RegisterError } from './passkeys.ts';
export { PasskeyServiceProvider } from './provider.ts';
export { PasskeyConfig, PasskeySetupError } from './config.ts';
export type { PasskeyConfigValue } from './config.ts';
export { PASSKEYS_TABLE, PasskeyStore } from './store.ts';
export type { PasskeyRecord, PasskeyTable } from './store.ts';
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from './json.ts';

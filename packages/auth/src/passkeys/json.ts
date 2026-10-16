// The WebAuthn JSON shapes (W3C WebAuthn Level 3, "JSON serialization"): what `navigator.credentials` takes and returns once
// every byte string is base64url. They describe the form only — the verification in `webauthn.ts` still checks every value.

/** A byte string as base64url, without padding. */
export type Base64URLString = string;

export type PublicKeyCredentialType = 'public-key';
export type AuthenticatorAttachment = 'platform' | 'cross-platform';
export type ResidentKeyRequirement = 'discouraged' | 'preferred' | 'required';
export type UserVerificationRequirement = 'discouraged' | 'preferred' | 'required';
export type AttestationConveyancePreference = 'none' | 'indirect' | 'direct' | 'enterprise';
export type PublicKeyCredentialHint = 'security-key' | 'client-device' | 'hybrid';

export interface PublicKeyCredentialRpEntity {
  name: string;
  id?: string;
}

export interface PublicKeyCredentialUserEntityJSON {
  id: Base64URLString;
  name: string;
  displayName: string;
}

export interface PublicKeyCredentialParameters {
  type: PublicKeyCredentialType;
  /** A COSE algorithm identifier, e.g. `-7` for ES256. */
  alg: number;
}

export interface PublicKeyCredentialDescriptorJSON {
  type: PublicKeyCredentialType;
  id: Base64URLString;
  /** `AuthenticatorTransport` values (`ble`, `hybrid`, `internal`, `nfc`, `usb`); a browser ignores values it does not know. */
  transports?: string[];
}

export interface AuthenticatorSelectionCriteria {
  authenticatorAttachment?: AuthenticatorAttachment;
  residentKey?: ResidentKeyRequirement;
  requireResidentKey?: boolean;
  userVerification?: UserVerificationRequirement;
}

/** The extension inputs the framework itself produces. */
export interface AuthenticationExtensionsClientInputsJSON {
  credProps?: boolean;
}

export interface AuthenticationExtensionsPRFValuesJSON {
  first: Base64URLString;
  second?: Base64URLString;
}

export interface AuthenticationExtensionsClientOutputsJSON {
  appid?: boolean;
  appidExclude?: boolean;
  credProps?: { rk?: boolean };
  largeBlob?: { supported?: boolean; blob?: Base64URLString; written?: boolean };
  prf?: { enabled?: boolean; results?: AuthenticationExtensionsPRFValuesJSON };
  remoteClientDataJSON?: boolean;
}

/** The options for `navigator.credentials.create()`, as `PublicKeyCredential.parseCreationOptionsFromJSON()` reads them. */
export interface PublicKeyCredentialCreationOptionsJSON {
  rp: PublicKeyCredentialRpEntity;
  user: PublicKeyCredentialUserEntityJSON;
  challenge: Base64URLString;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  hints?: PublicKeyCredentialHint[];
  attestation?: AttestationConveyancePreference;
  attestationFormats?: string[];
  extensions?: AuthenticationExtensionsClientInputsJSON;
}

/** The options for `navigator.credentials.get()`, as `PublicKeyCredential.parseRequestOptionsFromJSON()` reads them. */
export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: Base64URLString;
  timeout?: number;
  rpId?: string;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
  userVerification?: UserVerificationRequirement;
  hints?: PublicKeyCredentialHint[];
  extensions?: AuthenticationExtensionsClientInputsJSON;
}

/**
 * The attestation part of a registration response. `authenticatorData`, `transports`, `publicKeyAlgorithm` and `publicKey` are
 * optional although the specification lists them: a browser from before Level 3 sends only `clientDataJSON` and `attestationObject`,
 * and the verification reads the key from the attestation object either way.
 */
export interface AuthenticatorAttestationResponseJSON {
  clientDataJSON: Base64URLString;
  attestationObject: Base64URLString;
  authenticatorData?: Base64URLString;
  transports?: string[];
  publicKeyAlgorithm?: number;
  publicKey?: Base64URLString;
}

export interface AuthenticatorAssertionResponseJSON {
  clientDataJSON: Base64URLString;
  authenticatorData: Base64URLString;
  signature: Base64URLString;
  userHandle?: Base64URLString;
}

/** What `navigator.credentials.create()` returned, serialised by `PublicKeyCredential.toJSON()`. */
export interface RegistrationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  response: AuthenticatorAttestationResponseJSON;
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults: AuthenticationExtensionsClientOutputsJSON;
  type: PublicKeyCredentialType;
}

/** What `navigator.credentials.get()` returned, serialised by `PublicKeyCredential.toJSON()`. */
export interface AuthenticationResponseJSON {
  id: Base64URLString;
  rawId: Base64URLString;
  response: AuthenticatorAssertionResponseJSON;
  authenticatorAttachment?: AuthenticatorAttachment;
  clientExtensionResults: AuthenticationExtensionsClientOutputsJSON;
  type: PublicKeyCredentialType;
}

// The framework's WebAuthn JSON types against the verification library's — checked by `tsc` (typecheck), never run.
import type {
  AuthenticationResponseJSON as LibraryAuthenticationResponse,
  PublicKeyCredentialCreationOptionsJSON as LibraryCreationOptions,
  PublicKeyCredentialRequestOptionsJSON as LibraryRequestOptions,
  RegistrationResponseJSON as LibraryRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from './json.ts';

declare function take<T>(value: T): void;

declare const authenticationResponse: AuthenticationResponseJSON;
declare const libraryAuthenticationResponse: LibraryAuthenticationResponse;
declare const registrationResponse: RegistrationResponseJSON;
declare const libraryRegistrationResponse: LibraryRegistrationResponse;
declare const creationOptions: PublicKeyCredentialCreationOptionsJSON;
declare const libraryCreationOptions: LibraryCreationOptions;
declare const requestOptions: PublicKeyCredentialRequestOptionsJSON;
declare const libraryRequestOptions: LibraryRequestOptions;

// Request options: the framework's go into the library's.
take<LibraryRequestOptions>(requestOptions);

// Not assignable, on purpose — `webauthn.ts` maps these fields instead of casting:
// - the library types `clientExtensionResults` with `BufferSource`s, the JSON form has base64url strings (`prf`);
// - the library's descriptors type `type` as `string`, the specification's value is `'public-key'`;
// - `attestationFormats` is a list of strings in the specification, the library narrows it to the registered formats.
// @ts-expect-error `prf` results are strings here, buffers there
take<LibraryAuthenticationResponse>(authenticationResponse);
// @ts-expect-error `prf` results are buffers there, strings here
take<AuthenticationResponseJSON>(libraryAuthenticationResponse);
// @ts-expect-error `prf` results are strings here, buffers there
take<LibraryRegistrationResponse>(registrationResponse);
// @ts-expect-error `prf` results are buffers there, strings here
take<RegistrationResponseJSON>(libraryRegistrationResponse);
// @ts-expect-error `attestationFormats` is wider here
take<LibraryCreationOptions>(creationOptions);
// @ts-expect-error descriptors carry `type: string` there
take<PublicKeyCredentialCreationOptionsJSON>(libraryCreationOptions);
// @ts-expect-error descriptors carry `type: string` there
take<PublicKeyCredentialRequestOptionsJSON>(libraryRequestOptions);

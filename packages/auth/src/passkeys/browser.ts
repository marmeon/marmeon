/**
 * `@marmeon/auth/passkeys/browser` — the browser side of passkeys: WebAuthn takes and gives ArrayBuffers, the server speaks JSON
 * (base64url). Current browsers convert themselves (`parse…FromJSON`, `toJSON()`); a small fallback covers the rest. It runs in the
 * page and imports nothing, in particular nothing from the server side of the package. See `docs/passkeys.md#the-browser-side`.
 *
 * @module
 */

/** Whether this browser can make and use passkeys at all. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && typeof navigator.credentials?.get === 'function';
}

/** Whether the browser can offer passkeys inside the e-mail field's autofill (`autocomplete="username webauthn"`). */
export async function conditionalAvailable(): Promise<boolean> {
  return passkeysAvailable() && (await window.PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
}

/** base64url text (what the server sends) to the bytes WebAuthn takes. */
export const bufferFromBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer;
};
/** The bytes WebAuthn gives to base64url text (what the server takes); `null` is an empty string. */
export const base64UrlFromBuffer = (buffer: ArrayBuffer | null): string => {
  if (buffer === null) return '';
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

type Json = Record<string, any>;

function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const native = (window.PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: (json: Json) => PublicKeyCredentialCreationOptions }).parseCreationOptionsFromJSON;
  if (native) return native(json);
  return {
    ...json,
    challenge: bufferFromBase64Url(json.challenge),
    user: { ...json.user, id: bufferFromBase64Url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((credential: Json) => ({ ...credential, id: bufferFromBase64Url(credential.id) })),
  } as PublicKeyCredentialCreationOptions;
}

function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const native = (window.PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (json: Json) => PublicKeyCredentialRequestOptions }).parseRequestOptionsFromJSON;
  if (native) return native(json);
  return {
    ...json,
    challenge: bufferFromBase64Url(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((credential: Json) => ({ ...credential, id: bufferFromBase64Url(credential.id) })),
  } as PublicKeyCredentialRequestOptions;
}

/** Asks the authenticator for a new passkey. Throws when the user cancels or the browser refuses. */
export async function createPasskey(optionsJson: Json): Promise<Json> {
  const credential = (await navigator.credentials.create({ publicKey: creationOptions(optionsJson) })) as PublicKeyCredential | null;
  if (credential === null) throw new Error('No passkey was made.');
  if (typeof credential.toJSON === 'function') return credential.toJSON() as Json;
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: base64UrlFromBuffer(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: base64UrlFromBuffer(response.clientDataJSON),
      attestationObject: base64UrlFromBuffer(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

/** Asks the authenticator to sign in. `conditional` waits in the e-mail field's autofill until the user picks a passkey (`signal` ends the wait). */
export async function getPasskey(optionsJson: Json, { conditional = false, signal }: { conditional?: boolean; signal?: AbortSignal } = {}): Promise<Json> {
  const credential = (await navigator.credentials.get({
    publicKey: requestOptions(optionsJson),
    ...(conditional ? { mediation: 'conditional' as CredentialMediationRequirement } : {}),
    ...(signal ? { signal } : {}),
  })) as PublicKeyCredential | null;
  if (credential === null) throw new Error('No passkey was chosen.');
  if (typeof credential.toJSON === 'function') return credential.toJSON() as Json;
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64UrlFromBuffer(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: base64UrlFromBuffer(response.clientDataJSON),
      authenticatorData: base64UrlFromBuffer(response.authenticatorData),
      signature: base64UrlFromBuffer(response.signature),
      userHandle: response.userHandle === null ? undefined : base64UrlFromBuffer(response.userHandle),
    },
  };
}

/** A same-origin JSON request: the browser's Fetch Metadata vouches for it. A redirect (a finished sign-in) is followed by the page. */
export async function postJson(url: string, body: Json = {}, signal?: AbortSignal): Promise<{ ok: boolean; status: number; data: Json }> {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (response.redirected) {
    window.location.assign(response.url);
    return { ok: true, status: 200, data: {} };
  }
  const data = response.headers.get('content-type')?.includes('json') ? ((await response.json()) as Json) : {};
  return { ok: response.ok, status: response.status, data };
}

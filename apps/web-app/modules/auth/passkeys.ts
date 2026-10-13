// The browser side of passkeys: WebAuthn takes and gives ArrayBuffers, the server speaks JSON (base64url). Current browsers convert
// themselves (`parse…FromJSON`, `toJSON()`); the small fallback below covers the rest. App code, so the app owns it.

/** Whether this browser can make and use passkeys at all. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined' && typeof navigator.credentials?.get === 'function';
}

/** Whether the browser can offer passkeys inside the e-mail field's autofill (`autocomplete="username webauthn"`). */
export async function conditionalAvailable(): Promise<boolean> {
  return passkeysAvailable() && (await window.PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
}

const toBuffer = (value: string): ArrayBuffer => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer;
};
const toBase64Url = (buffer: ArrayBuffer | null): string => {
  if (buffer === null) return '';
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

type Json = Record<string, any>;

function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const native = (window.PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: (json: Json) => PublicKeyCredentialCreationOptions }).parseCreationOptionsFromJSON;
  if (native) return native(json);
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    user: { ...json.user, id: toBuffer(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((credential: Json) => ({ ...credential, id: toBuffer(credential.id) })),
  } as PublicKeyCredentialCreationOptions;
}

function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  const native = (window.PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (json: Json) => PublicKeyCredentialRequestOptions }).parseRequestOptionsFromJSON;
  if (native) return native(json);
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((credential: Json) => ({ ...credential, id: toBuffer(credential.id) })),
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
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
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
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle === null ? undefined : toBase64Url(response.userHandle),
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

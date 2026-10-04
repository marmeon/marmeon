/**
 * The CSP nonce of one response (E147): 16 random bytes, base64 — made on first use, then the same for everything the
 * response carries (the `Content-Security-Policy` header, React's streamed scripts, the document's `<script>` and
 * `<style>` tags). A request that never renders a document (a JSON visit, an API call) never makes one.
 *
 * The kernel binds one per request (`scope.make(RequestNonce)`); `ctx.nonce()` reads it.
 */
export class RequestNonce {
  #value: string | undefined;
  #wanted = false;

  /** The nonce — made now if nothing asked for it before. */
  get value(): string {
    return (this.#value ??= createNonce());
  }

  /**
   * Says that documents of this response need the nonce — the `contentSecurityPolicy()` middleware does, before the
   * route runs — without making it yet: a response that turns out to be JSON never does.
   */
  want(): void {
    this.#wanted = true;
  }

  /** The nonce a document of this response carries: when something wants one or made one already, else none. */
  forDocument(): string | undefined {
    return this.#wanted || this.#value !== undefined ? this.value : undefined;
  }
}

/** Random bytes drawn 4 KiB at a time (256 nonces): one call into the system's CSPRNG instead of one per response. */
const pool = new Uint8Array(4096);
let used = pool.length;

/**
 * 16 random bytes as base64 (128 bits, as the CSP specification asks for at least) — bytes of the pool, each used once.
 * `getRandomValues` per nonce costs ≈ 1 µs; from the pool ≈ 0.15 µs.
 */
export function createNonce(): string {
  if (used + 16 > pool.length) {
    crypto.getRandomValues(pool);
    used = 0;
  }
  const bytes = pool.subarray(used, used + 16);
  used += 16;
  return (bytes as Uint8Array & { toBase64(): string }).toBase64();
}

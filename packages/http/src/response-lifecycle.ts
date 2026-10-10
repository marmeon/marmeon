/**
 * Where the current request's response stands — per request (scoped). A server-rendered page streams on after its
 * headers went out: the status, the headers and the session cookie are fixed from then on, so what still runs in
 * the request's scope — its deferred props, computed while the page streams — runs read-only, like an island.
 * The kernel marks the moment; what streams waits for it.
 */
export class ResponseLifecycle {
  readonly #sent = Promise.withResolvers<void>();
  #headersSent = false;

  /** Whether the response's headers are out (the session saved, its cookie set). */
  get headersSent(): boolean {
    return this.#headersSent;
  }

  /** Resolves once the response's headers are out — and the request is read-only. */
  whenHeadersSent(): Promise<void> {
    return this.#sent.promise;
  }

  /** @internal — the kernel, once the response is handed to the server (and the request made read-only). */
  markHeadersSent(): void {
    if (this.#headersSent) return;
    this.#headersSent = true;
    this.#sent.resolve();
  }
}

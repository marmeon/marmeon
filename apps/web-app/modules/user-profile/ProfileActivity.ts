/** When each user last signed in. In-memory until the data layer (Wave 3) exists. */
export class ProfileActivity {
  readonly #lastLogin = new Map<string, Date>();

  recordLogin(userId: string, at: Date): void {
    this.#lastLogin.set(userId, at);
  }

  lastLogin(userId: string): Date | undefined {
    return this.#lastLogin.get(userId);
  }
}

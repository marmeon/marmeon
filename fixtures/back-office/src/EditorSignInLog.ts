/** One sign-in of an editor: which mode it happened in (the guard's name, `web` for the app's users), the id in that mode's table, and when. */
export interface EditorSignIn {
  readonly guard: string;
  readonly userId: number;
  readonly at: Date;
}

/** Where `RecordEditorSignIn` writes. Kept in memory: a package of your own would write a table. */
export class EditorSignInLog {
  readonly #entries: EditorSignIn[] = [];

  record(entry: EditorSignIn): void {
    this.#entries.push(entry);
  }

  entries(): readonly EditorSignIn[] {
    return [...this.#entries];
  }
}

import { SNIPPETS, type SnippetName } from './snippets.ts';

export type ChainStepId = 'migration' | 'row' | 'repository' | 'controller' | 'route' | 'props' | 'form';

/** One step of "a typo anywhere is a compile error": the snippet it points at and the misspelling the page shows in it. */
export interface ChainStepSpec {
  readonly id: ChainStepId;
  readonly title: string;
  /** The snippet that holds the typo; its source must be a file of the smoke app. */
  readonly snippet: SnippetName;
  /** `find` stands exactly once in the snippet's code and in its source file; `replace` is the misspelled text. */
  readonly typo: { readonly find: string; readonly replace: string };
  /** The compiler's answer to the typo, as `pnpm pack:smoke` reproduces it: the code and the first line of the message, word for word. */
  readonly error: { readonly code: `TS${number}`; readonly message: string };
}

export const CHAIN: readonly ChainStepSpec[] = [
  { id: 'migration', title: 'Migration', snippet: 'migration', typo: { find: "table.string('title', 120)", replace: "table.strng('title', 120)" }, error: { code: 'TS2551', message: `Property 'strng' does not exist on type 'Blueprint'. Did you mean 'string'?` } },
  { id: 'row', title: 'Row', snippet: 'tableType', typo: { find: "type Note = Row<'notes'>", replace: "type Note = Row<'ntoes'>" }, error: { code: 'TS2344', message: `Type '"ntoes"' does not satisfy the constraint 'keyof Tables'.` } },
  { id: 'repository', title: 'Repository', snippet: 'repository', typo: { find: ".where('user_id'", replace: ".where('user_ud'" }, error: { code: 'TS2345', message: `Argument of type '"user_ud"' is not assignable to parameter of type 'ReferenceExpression<Tables, "notes">'.` } },
  { id: 'controller', title: 'Controller', snippet: 'controllerCall', typo: { find: 'ctx.params.note', replace: 'ctx.params.nte' }, error: { code: 'TS2551', message: `Property 'nte' does not exist on type '{ note: { body: string; created_at: string; id: string; pinned: boolean; title: string; updated_at: string; user_id: number; }; }'. Did you mean 'note'?` } },
  { id: 'route', title: 'Route', snippet: 'routeLink', typo: { find: 'route="notes.index"', replace: 'route="notes.indx"' }, error: { code: 'TS2322', message: `Type '"notes.indx"' is not assignable to type '"'notes.indx' is not a route name — did you mean notes.index?"'.` } },
  { id: 'props', title: 'Props', snippet: 'page', typo: { find: '<h1>{note.title}</h1>', replace: '<h1>{note.titel}</h1>' }, error: { code: 'TS2551', message: `Property 'titel' does not exist on type '{ body: string; created_at: string; id: string; pinned: boolean; title: string; updated_at: string; user_id: number; }'. Did you mean 'title'?` } },
  { id: 'form', title: 'Form error', snippet: 'form', typo: { find: "{form.error('title') &&", replace: "{form.error('titel') &&" }, error: { code: 'TS2345', message: `Argument of type '"titel"' is not assignable to parameter of type '"_" | "body" | "title"'.` } },
];

/** The line of the step's snippet that holds `find`, with the typo in it and its indent cut off: what the page shows as "does not compile". */
export function mistakeLine(step: ChainStepSpec): string {
  const line = SNIPPETS[step.snippet].code.split('\n').find((candidate) => candidate.includes(step.typo.find));
  if (line === undefined) throw new Error(`The snippet "${step.snippet}" has no line with ${JSON.stringify(step.typo.find)}.`);
  return line.replace(step.typo.find, () => step.typo.replace).trim();
}

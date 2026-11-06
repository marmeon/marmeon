import type { NewRow, Row, RowUpdate } from '@marmeon/database';

// A row as read.
export type Note = Row<'notes'>;
// What an insert takes.
export type NewNote = NewRow<'notes'>;
// What an update takes.
export type NoteChanges = RowUpdate<'notes'>;

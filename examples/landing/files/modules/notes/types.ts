import type { NewRow, Row, RowUpdate } from '@marmeon/database';

export type Note = Row<'notes'>; // a row as read
export type NewNote = NewRow<'notes'>; // what an insert takes
export type NoteChanges = RowUpdate<'notes'>; // what an update takes

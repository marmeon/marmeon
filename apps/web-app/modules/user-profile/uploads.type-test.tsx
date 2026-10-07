import type { ContextOf } from '@marmeon/http';
import type { Upload } from '@marmeon/http/page';
import { FileInput, useForm } from '@marmeon/react';
import { upload, type TemporaryUpload } from '@marmeon/storage';
import type { TestApp } from '@marmeon/testing';
import type { UpdateAvatarRequest } from './controllers/UpdateAvatarController.ts';

// Uploads (W6.9) as types — checked by `pnpm typecheck`, never run.

/** On the server: an upload() field is a verified TemporaryUpload — never the token string. */
export function serverTypes(ctx: ContextOf<typeof UpdateAvatarRequest>) {
  const avatar: TemporaryUpload = ctx.body.avatar;
  void avatar.store;
  // @ts-expect-error — the field is the verified upload, not its token
  const token: string = ctx.body.avatar;
  void token;

  upload({ maxBytes: 1_000_000, mime: ['image/png', 'application/pdf'] });
  // @ts-expect-error — a type uploads cannot recognise by its bytes (did you mean …)
  upload({ maxBytes: 1_000_000, mime: ['image/pgn'] });
  // @ts-expect-error — SVG is never accepted: a browser runs script in it
  upload({ maxBytes: 1_000_000, mime: ['image/svg+xml'] });
  // @ts-expect-error — not a type at all
  upload({ maxBytes: 1_000_000, mime: ['text/csv'] });
}

/** In the browser: the field holds an Upload (or nothing yet); `form.field()` only for upload fields. */
export function ClientTypes() {
  const avatar = useForm('user-profile.avatar.update', { user: 1 }, { avatar: null });
  const value: Upload | null = avatar.data.avatar;
  void value?.progress;
  const profile = useForm('user-profile.update', { user: 1 }, { name: '', bio: '' });
  // @ts-expect-error — `bio` has no upload() rule (and this form has no upload field)
  profile.field('bio');
  // @ts-expect-error — not a field of this form
  avatar.field('avatr');
  // @ts-expect-error — an upload field takes an Upload, never a string
  avatar.set('avatar', 'tu_…');
  return <FileInput field={avatar.field('avatar')} accept="image/png" />;
}

/** In tests: `app.upload(route, field, file)` — the field must be one of the route's upload fields. */
export async function testTypes(app: TestApp) {
  const file = new File(['png'], 'a.png');
  const token: string = await app.upload('user-profile.avatar.update', 'avatar', file, { user: 1 });
  void token;
  // @ts-expect-error — `bio` has no upload() rule on this route
  await app.upload('user-profile.update', 'bio', file, { user: 1 });
  // @ts-expect-error — the route takes a user
  await app.upload('user-profile.avatar.update', 'avatar', file);
}

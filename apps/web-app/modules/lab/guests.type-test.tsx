/** Type guarantees of `FormPart` with the guest forms' controllers — checked by `tsc` (`pnpm typecheck`), never run. */
import type { FormHandle, FormPart } from '@marmeon/react';
import { GuestFields } from './GuestFields.tsx';
import type { StoreGuestLabController, UpdateGuestLabController } from './controllers/GuestLabController.ts';
import type { StoreValidationLabController } from './controllers/ValidationLabController.ts';
import type { StoreInvitationLabController } from './controllers/InvitationLabController.ts';

export function shared(create: FormHandle<StoreGuestLabController>, edit: FormHandle<UpdateGuestLabController>, invitation: FormHandle<StoreInvitationLabController>, validation: FormHandle<StoreValidationLabController>) {
  void GuestFields({ form: create });
  void GuestFields({ form: edit });
  // @ts-expect-error — a controller whose schema has no `email`
  void GuestFields({ form: invitation });
  // Validation's `email` is typed the same, so it fits as well.
  void GuestFields({ form: validation });
}

export function errors(part: FormPart<UpdateGuestLabController, 'name' | 'email'>) {
  void part.errors.name;
  void part.errors._;
  // @ts-expect-error — `coming` is not part of the part
  void part.errors.coming;
  // @ts-expect-error — a field neither controller has
  void part.errors.invite;
}

// @ts-expect-error — `invite` is a field of the create form only
export type NotInEdit = FormPart<UpdateGuestLabController, 'invite'>;

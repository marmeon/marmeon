import { defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { LabGate } from './ValidationLabController.ts';
import { LabController } from './ShowLabPageController.ts';

/** The fields a guest's create and edit forms share — their rules are the same, and so is the component that shows them. */
const shared = {
  name: r.string().trim().required().max(40),
  email: r.string().trim().lowercase().required().email().max(255),
};

/** Adding a guest: the shared fields, and the code that invited them. */
export const StoreGuestLabRequest = defineRequest({
  schema: r.object({ ...shared, invite: r.string().trim().max(40).optional() }),
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** Changing a guest: the shared fields, and whether the guest is still coming. */
export const UpdateGuestLabRequest = defineRequest({
  schema: r.object({ ...shared, coming: r.boolean() }),
  authorize: (_ctx, resolve) => resolve(LabGate).open(),
});

/** The form that adds a guest. */
export class CreateGuestLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/GuestCreate', {});
  }
}

/** The form that changes the guest the lab keeps in view — nothing is stored, so the same guest every time. */
export class EditGuestLabController extends LabController {
  handle() {
    this.enabled();
    return this.view('lab/GuestEdit', { guest: { name: 'Ada Lovelace', email: 'ada@example.test', coming: true } });
  }
}

/** Takes the new guest — valid means nothing more here, nothing is saved. */
export class StoreGuestLabController extends LabController {
  static request = StoreGuestLabRequest;

  handle(ctx: ContextOf<typeof StoreGuestLabRequest>) {
    this.enabled();
    return this.redirect('/lab/guests/new').flash('toast', { kind: 'success', message: `Added ${ctx.body.name} — nothing was saved.` });
  }
}

/** Takes the changed guest — valid means nothing more here, nothing is saved. */
export class UpdateGuestLabController extends LabController {
  static request = UpdateGuestLabRequest;

  handle(ctx: ContextOf<typeof UpdateGuestLabRequest>) {
    this.enabled();
    return this.redirect('/lab/guests/edit').flash('toast', { kind: 'success', message: `Changed ${ctx.body.name} — nothing was saved.` });
  }
}

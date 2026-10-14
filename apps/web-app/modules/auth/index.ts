import { Login, Registered } from '@marmeon/auth';
import { PasskeyServiceProvider } from '@marmeon/auth/passkeys';
import { defineModule, listen } from '@marmeon/core';
import { NotifyAboutNewSignIn } from './listeners/NotifyAboutNewSignIn.ts';
import { SendEmailVerification } from './listeners/SendEmailVerification.ts';
import { QueueWelcomeMail } from './listeners/QueueWelcomeMail.ts';
import { SendAccountExistsMailJob } from './jobs/SendAccountExistsMailJob.ts';
import { SendEmailChangeMailJob } from './jobs/SendEmailChangeMailJob.ts';
import { SendPasswordResetLinkJob } from './jobs/SendPasswordResetLinkJob.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';
import { AuthServiceProvider } from './AuthServiceProvider.ts';
import { EndSessionsCommand } from './commands/EndSessionsCommand.ts';
import { PruneUnverifiedCommand } from './commands/PruneUnverifiedCommand.ts';
import { NewSignInNotification } from './notifications/NewSignInNotification.ts';
import { UserRecipients } from './UserRecipients.ts';
import { DemoUsersSeeder } from './seeders/DemoUsersSeeder.ts';
import routes from './routes.ts';
import { schedule } from './schedule.ts';

// Public API of the auth module. Other modules import from here, never from internals.
export { AccountDeleted, AccountDeletion } from './AccountDeletion.ts';
export { UserFactory } from './factories/UserFactory.ts';
export { NewSignInNotification } from './notifications/NewSignInNotification.ts';
export { UserRepository } from './UserRepository.ts';
export type { User } from './users.ts';

export default defineModule({
  name: 'auth',
  // PasskeyServiceProvider switches passkeys on. To switch them off, remove it, `PasskeyStore` from `combineFactors` in AuthServiceProvider, and
  // both imports of '@marmeon/auth/passkeys': the WebAuthn library is loaded only by code that imports that subpath.
  providers: [AuthServiceProvider, PasskeyServiceProvider],
  // SendEmailVerification is a queued listener (static queue): a worker runs it after the registration committed.
  // NotifyAboutNewSignIn is queued too: a sign-in with a password becomes a notification (bell + mail) in a worker.
  listeners: [listen(Registered, SendEmailVerification), listen(Registered, QueueWelcomeMail), listen(Login, NotifyAboutNewSignIn)],
  // The module's notifications (a worker finds them by name) — and how a notification finds a user again.
  notifications: [NewSignInNotification],
  recipients: { user: UserRecipients },
  // Queued work of this module — a worker (`marmeon queue:work`, started by `marmeon dev`) runs only registered jobs.
  // SendAccountExistsMailJob: private registration — the note to an account's owner that someone signed up with its address;
  // SendEmailChangeMailJob: the link to a new address, or the note to the owner of a taken one.
  jobs: [SendWelcomeMailJob, SendPasswordResetLinkJob, SendAccountExistsMailJob, SendEmailChangeMailJob],
  migrations: new URL('./migrations/', import.meta.url),
  // Other modules may read and join `users` — writing goes through the UserRepository.
  exposes: ['users'],
  seeders: [DemoUsersSeeder],
  routes,
  // Scheduled work: the nightly prune of tokens, expired changes of address and unconfirmed accounts (marmeon schedule:work).
  schedule,
  // marmeon auth:prune-unverified — the accounts whose address was not confirmed in time (the schedule runs it nightly).
  // marmeon auth:end-sessions <email> --force — signs an account out everywhere (a lost device, a suspected theft).
  // Other modules clear what belongs to a deleted account by listening to AccountDeleted (user-profile: the avatar; notifications).
  commands: [EndSessionsCommand, PruneUnverifiedCommand],
});

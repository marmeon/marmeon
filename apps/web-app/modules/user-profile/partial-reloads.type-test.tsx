/**
 * Type guarantees of partial reloads and deferred props (W5.3, E7) against this app's profile page — checked by
 * `tsc` (`pnpm typecheck`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment
 * above it is the message they get (read with the directive removed).
 */
import { Controller, defer, optional, type PageProps } from '@bespokecore/http';
import { Deferred, Link, useRouter } from '@bespokecore/react';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

type Props = PageProps<ShowUserProfileController>;

export function OnTheProfilePage({ activity, stats, others }: Props) {
  const router = useRouter<ShowUserProfileController>();
  void router.reload({ only: ['stats'] });
  void router.reload({ only: ['activity', 'others'], except: ['flash'] });
  void router.visit('/users/7?page=2', { only: ['others'], preserveState: true });
  // Typed with the props, too.
  void useRouter<Props>().reload({ only: ['stats'] });
  // Untyped without a page: any name.
  void useRouter().reload({ only: ['anything'] });

  // Type '"stat"' is not assignable to type '"activity" | "auth" | "can" | "email" | "errors" | "filter" | "flash" |
  // "isOwnProfile" | "lastLoginAt" | "now" | "others" | "profile" | "stats"'. Did you mean '"stats"'?
  // @ts-expect-error
  void router.reload({ only: ['stat'] });
  // Type '"profil"' is not assignable to type '…'. Did you mean '"profile"'?
  // @ts-expect-error
  void router.reload({ except: ['profil'] });
  // Type '"links"' is not assignable to type '…'. (`links` is a part of `profile`, not a prop.)
  // @ts-expect-error
  void router.visit('/users/7', { only: ['links'] });

  // A function prop is its result; optional() and defer() props may be missing.
  void others.data.length;
  void stats?.members;
  void activity?.length;
  // 'stats' is possibly 'undefined'.
  // @ts-expect-error
  void stats.members;
  // 'activity' is possibly 'undefined'.
  // @ts-expect-error
  void activity.length;

  return (
    <>
      <Link route="user-profile.show" params={{ user: 7 }} only={['others']} preserveState>
        Next
      </Link>
      {/* Checked against the props of the route's page — Type '"other"' is not assignable to type '…'. Did you mean '"others"'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ user: 7 }} only={['other']}>
        Next
      </Link>
      <Link href="/users/7" only={['whatever']}>
        Unchecked
      </Link>
      <Deferred<ShowUserProfileController> data="activity">ready</Deferred>
      <Deferred<ShowUserProfileController> data={['activity', 'stats']} fallback="…">
        {() => 'ready'}
      </Deferred>
      {/* Type '"activty"' is not assignable to type '"activity" | … | readonly ("activity" | …)[]'. Did you mean '"activity"'? */}
      {/* @ts-expect-error */}
      <Deferred<ShowUserProfileController> data="activty">ready</Deferred>
    </>
  );
}

export class WrappedProps extends Controller {
  handle() {
    return this.view('user-profile/Show', { stats: optional(async () => ({ links: 3 })), activity: defer(() => [new Date()]) });
  }
}
type Wrapped = PageProps<WrappedProps>;
// Serialize still applies: a Date of a deferred prop arrives as a string.
// Type 'Date' is not assignable to type 'string'.
// @ts-expect-error
export const deferredDate: Wrapped['activity'] = [new Date()];

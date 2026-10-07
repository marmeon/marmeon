import type { AuthUser } from '@marmeon/auth';

/** What the tests' members table asks: admins see e-mails and manage, they and exporters export; nobody deactivates themselves; Grace (id 3) is protected. */
export class MemberPolicy {
  viewEmails(user: AuthUser) {
    return user.admin === true;
  }

  manage(user: AuthUser) {
    return user.admin === true;
  }

  export(user: AuthUser) {
    return user.admin === true || user.exporter === true;
  }

  deactivate(user: AuthUser, member: { readonly id: number }) {
    return member.id !== user.id && member.id !== 3;
  }
}

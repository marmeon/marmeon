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

/** For the table keyed by e-mail: whoever is not the signed-in user's own address. */
export class EmailPolicy {
  deactivate(user: AuthUser, member: { readonly email: string }) {
    return member.email !== user.email;
  }
}

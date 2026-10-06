import type { Generated, Secret, Timestamp } from '@bespokecore/database';

/** The tables of the package's tests: members of teams, and their links. */
declare module '@bespokecore/database' {
  interface Tables {
    teams: {
      id: Generated<number>;
      name: string;
    };
    members: {
      id: Generated<number>;
      team_id: number;
      name: string;
      email: string;
      role: string;
      password: Secret<string>;
      created_at: Timestamp;
      last_seen_at: Timestamp | null;
    };
  }
}


declare module '@bespokecore/auth' {
  interface AuthTypes {
    user: { id: number; name: string; email: string; team: number; admin?: boolean; exporter?: boolean };
  }
}

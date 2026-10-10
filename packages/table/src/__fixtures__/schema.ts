import type { Generated, Secret, Timestamp } from '@marmeon/database';

/** The tables of the package's tests: members of teams, and their links. */
declare module '@marmeon/database' {
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
      active: boolean | null;
    };
  }
  // What `db:types` derives from `members.team_id` (a foreign key to `teams`).
  interface Relations {
    members: {
      team: { kind: 'belongsTo'; table: 'teams'; foreignKey: 'team_id'; localKey: 'team_id'; targetKey: 'id'; nullable: false };
    };
    teams: {
      members: { kind: 'hasMany'; table: 'members'; foreignKey: 'team_id'; localKey: 'id'; targetKey: 'team_id' };
    };
  }
}


declare module '@marmeon/auth' {
  interface AuthTypes {
    user: { id: number; name: string; email: string; team: number; admin?: boolean; exporter?: boolean };
  }
}

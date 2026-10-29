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
    vaults: {
      id: Generated<number>;
      team_id: number;
      token: Secret<string>;
    };
    ledger: {
      id: Generated<number>;
      note: string;
      qty: number;
      amount: string;
      paid: boolean;
      booked_at: Timestamp;
      meta: unknown;
      formula: string;
    };
  }
  // The modules `db:types` derives from the migrations' folders: `directory` owns the members and exposes its teams, `billing` the ledger.
  interface Modules {
    directory: true;
    billing: true;
  }
  interface TableOwners {
    teams: 'directory';
    members: 'directory';
    ledger: 'billing';
    vaults: 'directory';
  }
  interface ExposedTables {
    teams: true;
  }
  // What `db:types` derives from `members.team_id` (a foreign key to `teams`).
  interface Relations {
    vaults: {
      team: { kind: 'belongsTo'; table: 'teams'; foreignKey: 'team_id'; localKey: 'team_id'; targetKey: 'id'; nullable: false };
    };
    members: {
      team: { kind: 'belongsTo'; table: 'teams'; foreignKey: 'team_id'; localKey: 'team_id'; targetKey: 'id'; nullable: false };
    };
    teams: {
      members: { kind: 'hasMany'; table: 'members'; foreignKey: 'team_id'; localKey: 'id'; targetKey: 'team_id' };
      vaults: { kind: 'hasMany'; table: 'vaults'; foreignKey: 'team_id'; localKey: 'id'; targetKey: 'team_id' };
    };
  }
}


declare module '@marmeon/auth' {
  interface AuthTypes {
    user: { id: number; name: string; email: string; team: number; admin?: boolean; exporter?: boolean };
  }
}

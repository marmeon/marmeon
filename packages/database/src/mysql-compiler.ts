import { MysqlQueryCompiler } from 'kysely';

/** Kysely's MySQL compiler, where Marmeon's own differences from it go: what MySQL spells otherwise than the other drivers. */
export class MarmeonMysqlCompiler extends MysqlQueryCompiler {}

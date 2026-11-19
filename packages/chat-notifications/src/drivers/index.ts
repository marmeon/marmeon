import type { ChatDriver } from '../driver.ts';
import { discord } from './discord.ts';
import { slack } from './slack.ts';
import { teams } from './teams.ts';

/** The drivers the package ships, by the name they are registered under. @internal */
export const BUILT_IN_DRIVERS = Object.freeze({ slack, discord, teams } satisfies Record<string, ChatDriver>);

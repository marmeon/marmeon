import { parseRange } from '../addresses.ts';
import { send } from '../direct.ts';

// Run by direct.test.ts in a child process whose environment names a proxy: prints the status the target answered.
const response = await send({ url: new URL(process.argv[2]!) }, { allow: [parseRange('127.0.0.1/32')] });
process.stdout.write(`${response.status}\n`);
await response.body.cancel();

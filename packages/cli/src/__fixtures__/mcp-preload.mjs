// Preloaded into `marmeon mcp` by the tests (NODE_OPTIONS=--import). The launcher runs in this process: the tests start with the
// `@marmeon/source` condition, so it does not start a second Node.
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// MCP_SDK_LOG: a line for every time the MCP SDK is asked for, so a test sees whether a command loaded it.
if (process.env.MCP_SDK_LOG) {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@modelcontextprotocol/')) appendFileSync(process.env.MCP_SDK_LOG, `${specifier}\n`);
      return next(specifier, context);
    },
  });
}

// MCP_NOISE: on SIGUSR2 the process writes it every way a program writes to stdout, as a library or an app's code might.
if (process.env.MCP_NOISE) {
  process.on('SIGUSR2', () => {
    console.log(process.env.MCP_NOISE);
    console.info(process.env.MCP_NOISE);
    console.debug(process.env.MCP_NOISE);
    process.stdout.write(`${process.env.MCP_NOISE}\n`);
  });
}

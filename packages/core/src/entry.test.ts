import { describe, expect, it } from 'vitest';
import * as diagnostics from './diagnostics.ts';
import * as core from './index.ts';
import * as internal from './internal.ts';
import * as testing from './testing.ts';

describe('the entry points of the core', () => {
  it('keeps the framework plumbing out of the main entry and in ./internal', () => {
    for (const name of ['embedPackageInjections', 'withFileGuard', 'openTransactionOf', 'writeManifest', 'runWithRequest', 'staticNames', 'stringLiterals', 'runTransaction', 'rollBackOnErr']) {
      expect(core, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });

  it('drops the injection internals from every entry', () => {
    for (const name of ['analyzeInjections', 'injectConstructorDependencies', 'embedInjections', 'computeInjectionArtifacts', 'generateManifest']) {
      expect(core, name).not.toHaveProperty(name);
      expect(internal, name).not.toHaveProperty(name);
    }
  });

  it('keeps what an app documents in the main entry', () => {
    for (const name of ['createApplication', 'defineApplication', 'editDefinition', 'editDefinitionFile', 'importedBindings', 'escapeControls', 'afterCommit']) expect(core, name).toHaveProperty(name);
  });

  it('does not export the redaction limits and the helpers of the environment entry', () => {
    for (const name of ['MAX_ENTRY_BYTES', 'ENCRYPTED', 'REDACTED_KEYS', 'currentTransaction', 'NODE_ENVIRONMENTS', 'DOTENV_MARKER', 'resolveEnvironment']) expect(core, name).not.toHaveProperty(name);
  });

  it('puts the test doubles in ./testing only', () => {
    for (const name of ['EventFake', 'TestClock']) {
      expect(core, name).not.toHaveProperty(name);
      expect(testing, name).toHaveProperty(name);
    }
  });

  it('publishes channels from ./diagnostics and the publishing helpers from ./internal', () => {
    expect(diagnostics).toHaveProperty('channels');
    for (const name of ['messageBase', 'trace', 'publishEnded']) {
      expect(diagnostics, name).not.toHaveProperty(name);
      expect(internal, name).toHaveProperty(name);
    }
  });
});

import { describe, expect, it } from 'vitest';
import * as entry from './index.ts';

describe('the package entry', () => {
  it('exports the service, the job, the errors and the escape helpers and nothing internal', () => {
    expect(Object.keys(entry).sort()).toEqual(['ChatConfig', 'ChatDeliveryError', 'ChatError', 'ChatNotifier', 'ChatServiceProvider', 'ChatSetupError', 'SendQueuedChatMessage', 'escapeDiscordMarkdown', 'escapeSlackText']);
    expect(entry.ChatDeliveryError.prototype).toBeInstanceOf(entry.ChatError);
  });
});

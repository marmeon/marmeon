import { Html } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { Mjml, mjml } from './mjml.ts';

describe('mjml', () => {
  it('makes an Mjml that is an Html', () => {
    const made = mjml`<mjml></mjml>`;
    expect(made).toBeInstanceOf(Mjml);
    expect(made).toBeInstanceOf(Html);
  });

  it('refuses a construction without the template', () => {
    expect(() => Reflect.construct(Mjml, ['<x>'])).toThrow(TypeError);
    class Forged extends (Mjml as any) {
      constructor(markup: string) {
        super(markup);
      }
    }
    expect(() => new Forged('<x>')).toThrow(TypeError);
  });
});

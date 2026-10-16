import { describe, expect, it } from 'vitest';
import { collectDrivers } from './drivers.ts';
import type { ServiceProviderClass } from './provider.ts';

const factory = () => ({});
const provider = (name: string, drivers: unknown): ServiceProviderClass => {
  const Provider = class {
    static drivers = drivers;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  return Provider as unknown as ServiceProviderClass;
};
const collect = (providers: ServiceProviderClass[]) => collectDrivers(providers, 'drivers', ['database', 'redis'], 'queue driver');

describe('collectDrivers', () => {
  it('collects the drivers of every provider by name; a provider without any adds none', () => {
    const drivers = collect([provider('A', { sqs: factory }), provider('B', undefined), provider('C', { 'memory-x': factory })]);
    expect([...drivers.keys()]).toEqual(['sqs', 'memory-x']);
    expect(drivers.get('sqs')).toBe(factory);
  });

  it('takes a provider listed twice once', () => {
    const A = provider('A', { sqs: factory });
    expect([...collect([A, A]).keys()]).toEqual(['sqs']);
  });

  it('refuses a built-in name', () => {
    expect(() => collect([provider('Evil', { redis: factory })])).toThrow(/Evil brings a queue driver named "redis".*built-in/);
  });

  it('refuses one name from two providers, naming both', () => {
    expect(() => collect([provider('First', { sqs: factory }), provider('Second', { sqs: factory })])).toThrow(/"sqs" is brought by both First and Second/);
  });

  it('hints at inheritance when a subclass reads its parent\'s static record', () => {
    const Parent = provider('Parent', { sqs: factory });
    const Child = class extends (Parent as unknown as new () => object) {};
    Object.defineProperty(Child, 'name', { value: 'Child' });
    expect(() => collect([Parent, Child as unknown as ServiceProviderClass])).toThrow(/Parent and Child.*inherits its static drivers/);
  });

  it.each(['SQS', '../x', '', '1sqs', 'a_b', '__proto__'])('refuses the name %j', (name) => {
    const record: Record<string, unknown> = {};
    Object.defineProperty(record, name, { value: factory, enumerable: true });
    expect(() => collect([provider('Odd', record)])).toThrow(/lowercase letters/);
  });

  it('refuses a record that is no object, and a driver that is no function', () => {
    expect(() => collect([provider('P', [factory])])).toThrow(/must be an object/);
    expect(() => collect([provider('P', 'sqs')])).toThrow(/must be an object/);
    expect(() => collect([provider('P', { sqs: {} })])).toThrow(/P\.drivers\.sqs must be a function/);
  });
});

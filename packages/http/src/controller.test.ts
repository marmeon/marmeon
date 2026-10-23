import { describe, expect, it } from 'vitest';
import { Controller } from './controller.ts';

describe('Controller', () => {
  const collides =
    "Controller must not get another member: a new name collides with a member of the same name in an app's controller. Add the helper as a free function exported from @marmeon/http instead (like view, json and island).";

  it('has the six helpers and no others', () => {
    const methods = Object.getOwnPropertyNames(Controller.prototype)
      .filter((name) => name !== 'constructor')
      .sort();

    expect(methods, collides).toEqual(['back', 'closeLayer', 'island', 'json', 'redirect', 'view']);
  });

  it('has no static members and no instance fields', () => {
    expect(Object.getOwnPropertyNames(Controller).sort(), collides).toEqual(['length', 'name', 'prototype']);
    expect(Object.keys(new (class extends Controller {})()), collides).toEqual([]);
  });
});

import type { ClassResolver } from './types.ts';

/** The resolver for a router without a container: builds a class with `new`, refuses a token (there is nothing bound). */
export const buildWithNew: ClassResolver = (key) => {
  if (typeof key !== 'function') {
    throw new TypeError(`resolve(${key.name}): a token resolves only inside an app — there is no container here.`);
  }
  return new (key as new () => never)();
};

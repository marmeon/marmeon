/**
 * The path as Hono compiles it. A constraint (`:id{new|edit}`) is a regular expression Hono anchors with `^…$` — but the trie
 * router puts it between the anchors unwrapped, so a top-level `|` splits the anchors too: `new|edit` then matches `/new…`
 * as a prefix and `…edit` as a suffix. A constraint with a top-level alternative is wrapped in a non-capturing group so it
 * is matched as a whole; every other constraint, and `Route.path` itself, stays as written.
 */
export function honoPath(path: string): string {
  let out = '';
  let i = 0;
  while (i < path.length) {
    const open = /:[^/{}]+\{/y;
    open.lastIndex = i;
    const head = open.exec(path);
    if (!head) {
      out += path[i++];
      continue;
    }
    const start = i + head[0].length;
    let end = start;
    let inClass = false;
    for (let depth = 1; end < path.length; end++) {
      const char = path[end];
      if (char === '\\') end++;
      else if (inClass) inClass = char !== ']';
      else if (char === '[') inClass = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) break;
    }
    const body = path.slice(start, end);
    out += `${head[0]}${hasTopLevelAlternative(body) ? `(?:${body})` : body}`;
    i = end;
  }
  return out;
}

function hasTopLevelAlternative(pattern: string): boolean {
  let groups = 0;
  let inClass = false;
  let found = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') i++;
    else if (inClass) inClass = char !== ']';
    else if (char === '[') inClass = true;
    else if (char === '(') groups++;
    else if (char === ')') groups--;
    else if (char === '|' && groups === 0) found = true;
  }
  // An unbalanced pattern is not ours to repair: wrapping it would only move the error.
  return found && groups === 0 && !inClass;
}

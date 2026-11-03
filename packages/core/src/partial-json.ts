// Reading a JSON reply while it is still being streamed: the array items that are already complete,
// and the strings written so far in the item that isn't.

/**
 * The complete objects so far in the array under `key` (`{"steps":[{…},{…},{"st…` gives the first
 * two), and the raw text of the object being written after them, if any.
 */
export function streamedArray(text: string, key: string): { items: unknown[]; partial: string | null } {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!m) return { items: [], partial: null };
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      if (depth === 0 && ch === "{") start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth === 0) return { items, partial: null }; // the array closed
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          items.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // a malformed item; the final parse decides
        }
        start = -1;
      }
    }
  }
  return { items, partial: start >= 0 ? text.slice(start) : null };
}

/** Every value of `"key": "…"` in a fragment of JSON, decoded, the last one possibly unfinished. */
export function partialStrings(fragment: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`"${key}"\\s*:\\s*"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) {
    let i = m.index + m[0].length;
    let raw = "";
    for (; i < fragment.length; i++) {
      const ch = fragment[i];
      if (ch === "\\") {
        raw += fragment.slice(i, i + 2);
        i++;
      } else if (ch === '"') break;
      else raw += ch;
    }
    out.push(decode(raw));
    re.lastIndex = i;
  }
  return out;
}

function decode(raw: string): string {
  // Drop an escape cut off at the end (`\`, `\u12`).
  const clean = raw.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
  try {
    return JSON.parse(`"${clean}"`);
  } catch {
    return clean.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** A function that runs `fn` at most every `ms`, plus once more at the end via `flush`. */
export function throttle(fn: () => void, ms: number): { run: () => void; flush: () => void } {
  let last = 0;
  let pending = false;
  return {
    run() {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        pending = false;
        fn();
      } else pending = true;
    },
    flush() {
      if (pending) fn();
      pending = false;
    },
  };
}

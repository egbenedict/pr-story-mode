// Small dependency-free string hash (two FNV-1a passes) for stable atom IDs.

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashString(s: string): string {
  const a = fnv1a(s, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a(s, 0x01000193 ^ 0x5bd1e995).toString(16).padStart(8, "0");
  return a + b;
}

/** Stable atom ID: hash of file + symbol key + head SHA, shortened for readability in prompts. */
export function stableId(file: string, key: string, headSha: string): string {
  return "a" + hashString(`${file}\u0000${key}\u0000${headSha}`).slice(0, 8);
}

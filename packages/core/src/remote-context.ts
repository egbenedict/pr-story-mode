// Context from unchanged files of a repository that can be listed and read but not searched, such as
// GitHub without a local clone. Candidate files are picked from the file list (what the PR's files
// import or include, then their neighbours), downloaded once, and searched in memory.

import { definedOnLine, familyOf, type ContextSource } from "./context";
import { isGeneratedPath, isLockfile, packForPath } from "./languages";
import type { PRInput } from "./types";

export type RepoFile = { path: string; size: number };

export type RemoteContextOptions = {
  /** Candidate files downloaded up front (default 80), up to `maxTotalBytes` in all (default 3 MB). */
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Extra files named after a missing symbol, downloaded when definitions are looked up (default 10). */
  maxNamedFiles?: number;
  /** Larger files are skipped (default 150 kB). */
  maxFileBytes?: number;
  concurrency?: number;
};

const SKIP_DIRS = /(^|\/)(node_modules|vendor|third_party|third-party|external|dist|build|out|target|\.git)\//;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/** `a/b/../c/./d` → `a/c/d`; null when it climbs above the repository root. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const join = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * Repository paths that a file imports or includes, by simple per-language patterns, resolved
 * against the repository's files. Packages from outside the repository are ignored.
 */
export function importedPaths(path: string, text: string, files: Set<string>, dirs: Map<string, string[]>): string[] {
  const pack = packForPath(path);
  if (!pack) return [];
  const dir = dirOf(path);
  const out: string[] = [];
  const add = (p: string | null | undefined) => {
    if (p && files.has(p) && p !== path && !out.includes(p)) out.push(p);
  };
  // Paths ending in `suffix`, closest to this file first.
  const bySuffix = (suffix: string) => {
    const hits = [...files].filter((f) => f === suffix || f.endsWith(`/${suffix}`));
    return hits.sort((a, b) => sharedPrefix(b, path) - sharedPrefix(a, path) || a.length - b.length);
  };

  const family = familyOf(pack);
  if (family === "js") {
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) {
      const base = join(dir, m[1]);
      if (!base) continue;
      const noJs = base.replace(/\.(m|c)?js$/, "");
      const tries = [base, ...JS_EXTS.map((e) => noJs + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
      add(tries.find((t) => files.has(t)));
    }
  } else if (pack.id === "python") {
    const mods: { dots: number; mod: string; names: string[] }[] = [];
    // `from x import a, b` on one line, or `from x import (a,\n b)` across lines.
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([\w \t,]+))/gm))
      mods.push({ dots: m[1].length, mod: m[2], names: (m[3] ?? m[4]).split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean) });
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+)/gm)) mods.push({ dots: 0, mod: m[1], names: [] });
    for (const { dots, mod, names } of mods) {
      const rel = mod.replace(/\./g, "/");
      const targets = rel ? [rel] : names; // `from . import a, b` imports modules a and b
      for (const t of targets) {
        if (dots) {
          let base: string | null = dir;
          for (let i = 1; i < dots && base !== null; i++) base = base ? dirOf(base) : null;
          if (base === null) continue;
          add(join(base, `${t}.py`) ?? undefined);
          add(join(base, `${t}/__init__.py`) ?? undefined);
          // `from .pkg import mod`: the imported names may be modules
          if (rel) for (const n of names) add(join(base, `${t}/${n}.py`) ?? undefined);
        } else {
          add(bySuffix(`${t}.py`)[0]);
          add(bySuffix(`${t}/__init__.py`)[0]);
        }
      }
    }
  } else if (family === "c") {
    for (const m of text.matchAll(/^\s*#\s*include\s*([<"])([^">]+)[">]/gm)) {
      const inc = m[2];
      if (m[1] === '"') add(join(dir, inc));
      if (m[1] === '"' || inc.includes("/")) add(bySuffix(normalize(inc) ?? inc)[0]);
    }
  } else if (pack.id === "go") {
    const specs = [...text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    for (const m of text.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) specs.push(m[1]);
    for (const spec of specs) {
      // The longest repository directory that the import path ends with.
      const parts = spec.split("/");
      for (let k = Math.min(parts.length, 6); k >= 1; k--) {
        const suffix = parts.slice(-k).join("/");
        const hit = [...dirs.keys()].filter((d) => d === suffix || d.endsWith(`/${suffix}`)).sort((a, b) => a.length - b.length)[0];
        if (hit !== undefined) {
          for (const f of (dirs.get(hit) ?? []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).slice(0, 4)) add(f);
          break;
        }
      }
    }
  } else if (pack.id === "java") {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/gm)) {
      const parts = m[1].split(".");
      // `import static a.B.c` names a member: drop lower-case tails until a class name.
      while (parts.length > 1 && /^[a-z]/.test(parts[parts.length - 1]) && /^[A-Z]/.test(parts[parts.length - 2] ?? "")) parts.pop();
      add(bySuffix(`${parts.join("/")}.java`)[0]);
    }
  } else if (pack.id === "ruby") {
    // `require_relative "money"` is beside this file; `require "shop/cart"` is under a load path such as lib/.
    for (const m of text.matchAll(/^\s*require_relative\s*\(?\s*["']([^"']+)["']/gm)) {
      const base = join(dir, m[1]);
      add(base);
      if (base) add(`${base}.rb`);
    }
    for (const m of text.matchAll(/^\s*require\s*\(?\s*["']([^"']+)["']/gm)) {
      const rel = m[1].endsWith(".rb") ? m[1] : `${m[1]}.rb`;
      add(bySuffix(`lib/${rel}`)[0] ?? bySuffix(rel)[0]);
    }
  } else if (pack.id === "php") {
    // `use App\Models\User;` is usually app/Models/User.php (PSR-4): match the longest path tail.
    for (const m of text.matchAll(/^\s*use\s+(?:function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm)) {
      const parts = m[1].split("\\");
      for (let k = parts.length - 1; k >= Math.min(2, parts.length - 1) && k >= 1; k--) {
        const hit = bySuffix(`${parts.slice(-k).join("/")}.php`)[0];
        if (hit) {
          add(hit);
          break;
        }
      }
    }
    for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']\/?([^"']+\.php)["']/g)) add(join(dir, m[1]) ?? undefined);
  } else if (pack.id === "csharp") {
    // `using Shop.Core;`: files in the directory whose path ends with the namespace (Shop/Core, or Core).
    for (const m of text.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
      const parts = m[1].split(".");
      if (/^(System|Microsoft|Windows)$/.test(parts[0])) continue;
      for (let k = parts.length; k >= 1; k--) {
        const suffix = parts.slice(-k).join("/");
        const hit = [...dirs.keys()].filter((d) => d === suffix || d.endsWith(`/${suffix}`) || d === parts.slice(0, k).join(".") || d.endsWith(`/${parts.slice(0, k).join(".")}`)).sort((a, b) => a.length - b.length)[0];
        if (hit !== undefined) {
          for (const f of (dirs.get(hit) ?? []).filter((f) => f.endsWith(".cs")).slice(0, 4)) add(f);
          break;
        }
      }
    }
  } else if (pack.id === "rust") {
    const modDir = /^(mod|lib|main)\.rs$/.test(baseName(path)) ? dir : join(dir, stem(path)) ?? dir;
    for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
      add(join(modDir, `${m[1]}.rs`));
      add(join(modDir, `${m[1]}/mod.rs`));
    }
    for (const m of text.matchAll(/\buse\s+crate::([\w:]+)/g)) {
      const parts = m[1].split("::");
      for (let k = parts.length; k >= 1; k--) {
        const rel = parts.slice(0, k).join("/");
        const hit = bySuffix(`src/${rel}.rs`)[0] ?? bySuffix(`src/${rel}/mod.rs`)[0];
        if (hit) {
          add(hit);
          break;
        }
      }
    }
  }
  return out;
}

function sharedPrefix(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** Candidate files for context, best first: imports of the PR's files, then files in the same and nearby directories. */
export function rankCandidates(pr: PRInput, repo: RepoFile[], opts: RemoteContextOptions = {}): string[] {
  const maxBytes = opts.maxFileBytes ?? 150_000;
  const inPR = new Set(pr.files.flatMap((f) => [f.path, f.oldPath]));
  const families = new Set(pr.files.map((f) => packForPath(f.path)).flatMap((p) => (p && p.id !== "json" && !p.data ? [familyOf(p)] : [])));
  const usable = (f: RepoFile) => {
    const pack = packForPath(f.path);
    return !!pack && families.has(familyOf(pack)) && f.size <= maxBytes && !inPR.has(f.path) && !isLockfile(f.path) && !isGeneratedPath(f.path) && !SKIP_DIRS.test(f.path);
  };
  const all = new Set(repo.map((f) => f.path));
  const dirs = new Map<string, string[]>();
  for (const f of repo) dirs.set(dirOf(f.path), [...(dirs.get(dirOf(f.path)) ?? []), f.path]);
  const size = new Map(repo.map((f) => [f.path, f.size]));
  const ok = new Set(repo.filter(usable).map((f) => f.path));

  const score = new Map<string, number>();
  const bump = (p: string, s: number) => ok.has(p) && score.set(p, Math.max(score.get(p) ?? 0, s));
  for (const f of pr.files) {
    for (const text of [f.headText, f.baseText]) {
      if (!text) continue;
      importedPaths(f.path, text, all, dirs).forEach((p, i) => bump(p, 100 - Math.min(i, 20)));
    }
  }
  const prDirs = new Set(pr.files.map((f) => dirOf(f.path)));
  for (const d of prDirs) {
    for (const p of dirs.get(d) ?? []) bump(p, 50);
    for (const [other, ps] of dirs) if (other !== d && (dirOf(other) === d || dirOf(d) === other)) for (const p of ps) bump(p, 20);
  }
  // Tests call the code too, but the code's own callers are more useful.
  const testy = (p: string) => /(^|[/_.-])(tests?|spec|__tests__)([/_.-]|$)/i.test(p);
  const sorted = [...score.entries()]
    .map(([p, s]) => [p, s - (testy(p) ? 15 : 0)] as const)
    .sort((a, b) => b[1] - a[1] || (size.get(a[0]) ?? 0) - (size.get(b[0]) ?? 0))
    .map(([p]) => p);
  const out: string[] = [];
  let bytes = 0;
  for (const p of sorted) {
    if (out.length >= (opts.maxFiles ?? 80)) break;
    const n = size.get(p) ?? 0;
    if (bytes + n > (opts.maxTotalBytes ?? 3_000_000)) continue;
    out.push(p);
    bytes += n;
  }
  return out;
}

const normName = (s: string) => s.replace(/[-_]/g, "").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A ContextSource over a repository that can only be listed and read. Downloading starts as soon as
 * it's made, so it overlaps with ordering; lookups wait for it. Failures only mean less context.
 */
export function remoteContextSource(
  pr: PRInput,
  listFiles: () => Promise<RepoFile[]>,
  readFile: (path: string) => Promise<string | undefined>,
  opts: RemoteContextOptions = {},
): ContextSource & { ready: Promise<void>; fetched: () => string[] } {
  const texts = new Map<string, Promise<string | undefined>>();
  const read = (p: string) => {
    if (!texts.has(p)) texts.set(p, readFile(p).catch(() => undefined));
    return texts.get(p)!;
  };
  const tree = listFiles().catch(() => [] as RepoFile[]);
  const ranked = tree.then((files) => rankCandidates(pr, files, opts));
  const fetchAll = async (paths: string[]) => {
    let next = 0;
    const worker = async () => {
      while (next < paths.length) await read(paths[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, paths.length) }, worker));
  };
  const ready = ranked.then(fetchAll);
  const loaded = async () => {
    await ready;
    const out: [string, string][] = [];
    for (const [p, t] of texts) {
      const text = await t;
      if (text !== undefined) out.push([p, text]);
    }
    return out;
  };

  return {
    ready,
    fetched: () => [...texts.keys()],
    async findDefinitions(symbols) {
      const names = symbols.filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
      if (!names.length) return [];
      // Files named after a missing symbol (`Scheduler` → scheduler.ts) are worth a download too.
      const files = await tree;
      const wanted = new Set(names.map(normName));
      const inPR = new Set(pr.files.map((f) => f.path));
      const families = new Set(pr.files.map((f) => packForPath(f.path)).flatMap((p) => (p && !p.data ? [familyOf(p)] : [])));
      const named = files
        .filter((f) => !texts.has(f.path) && !inPR.has(f.path) && wanted.has(normName(stem(f.path))) && f.size <= (opts.maxFileBytes ?? 150_000) && !SKIP_DIRS.test(f.path))
        .filter((f) => {
          const pack = packForPath(f.path);
          return !!pack && families.has(familyOf(pack));
        })
        .slice(0, opts.maxNamedFiles ?? 10)
        .map((f) => f.path);
      await fetchAll(named);

      const exact = new Set(names);
      const counts = new Map<string, number>();
      for (const [p, text] of await loaded()) {
        if (!names.some((n) => text.includes(n))) continue;
        let n = 0;
        for (const line of text.split("\n")) if (line.length <= 400 && definedOnLine(line).some((d) => exact.has(d))) n++;
        if (n) counts.set(p, n);
      }
      // Most definitions first; ties in rank order, then files fetched by name.
      const order = await ranked;
      const rank = (p: string) => (order.indexOf(p) + 1 || 1e9);
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).map(([p]) => p);
    },
    async findReferences(symbols) {
      const names = symbols.filter((s) => /^[\w$]+$/.test(s));
      if (!names.length) return [];
      const re = new RegExp(`(^|[^\\w$])(${names.map(escapeRe).join("|")})(?![\\w$])`);
      const order = await ranked;
      const hits = (await loaded()).filter(([, text]) => re.test(text)).map(([p]) => p);
      return hits.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
    },
    readFile: read,
  };
}

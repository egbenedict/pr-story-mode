import type { PipelineResult, PRInput } from "@prstory/core";

/** A finished story with the PR it was built from, keyed by repository and PR number. */
export type CachedStory = { key: string; headSha: string; savedAt: number; pr: PRInput; result: PipelineResult };

const DB = "prstory";
const STORE = "stories";
const KEEP = 40; // stories kept; older ones are dropped

export const storyKey = (repo: string, number: number) => `${repo}#${number}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/** The cached story for a PR, whatever commit it was built at; null when there is none or storage fails. */
export async function getStory(key: string): Promise<CachedStory | null> {
  try {
    return (await run<CachedStory | undefined>("readonly", (s) => s.get(key))) ?? null;
  } catch {
    return null;
  }
}

export async function putStory(entry: CachedStory): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(entry));
    const all = await run<CachedStory[]>("readonly", (s) => s.getAll());
    const old = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP);
    for (const o of old) await run("readwrite", (s) => s.delete(o.key));
  } catch {
    // A cache failure only means the story is generated again next time.
  }
}

/** The repository part of a story's key: `owner/repo` on github.com, `host/owner/repo` elsewhere. */
export const repoKey = (ref: { host: string; owner: string; repo: string }) =>
  ref.host.toLowerCase() === "github.com" ? `${ref.owner}/${ref.repo}` : `${ref.host.toLowerCase()}/${ref.owner}/${ref.repo}`;

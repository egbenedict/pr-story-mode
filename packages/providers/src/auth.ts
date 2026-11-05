// Keys for model APIs and company gateways. A key can be fixed, or fetched (by running a command,
// say) and fetched again when the server rejects it, for gateway tokens that expire every hour.

/** Returns a key. `refresh` is true when the last one was rejected and a new one is needed. */
export type KeySource = (refresh: boolean) => Promise<string>;

/** How the key is sent: `x-api-key: <key>` (Anthropic's header) or `Authorization: Bearer <key>`. */
export type KeyHeader = "x-api-key" | "bearer";

export class Key {
  private current: Promise<string> | null = null;
  /** Bumped on each refresh, so several requests rejected at once refresh only once. */
  generation = 0;

  constructor(
    private source: KeySource,
    /** Whether asking again can give a different key (false for a key typed into settings). */
    readonly refreshable: boolean,
  ) {}

  static fixed(key: string): Key {
    return new Key(async () => key, false);
  }

  get(): Promise<string> {
    if (!this.current) {
      const p = this.source(this.generation > 0).then((k) => {
        const key = k.trim();
        if (!key) throw new Error("The key came back empty.");
        return key;
      });
      // A failed fetch is tried again next time instead of failing every later request.
      p.catch(() => {
        if (this.current === p) this.current = null;
      });
      this.current = p;
    }
    return this.current;
  }

  /** The key seen at `generation` was rejected: fetch a new one, unless another request already did. */
  refresh(generation: number): void {
    if (generation !== this.generation) return;
    this.generation++;
    this.current = null;
  }
}

/** Status codes gateways use for an expired or wrong key. 403 is included since some use it for expiry. */
export function isKeyRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * Runs `call`; when the server rejects the key and the key can change, gets a new one and runs it
 * once more. The call reads the key itself (through `key.get()`), so it always sends the newest.
 */
export async function withKeyRetry<T>(key: Key | null, call: () => Promise<T>): Promise<T> {
  if (!key?.refreshable) return call();
  const seen = key.generation;
  try {
    return await call();
  } catch (err) {
    if (!isKeyRejection(err)) throw err;
    key.refresh(seen);
    return call();
  }
}

/** Header name and value for a key. */
export function keyHeader(header: KeyHeader, key: string): [string, string] {
  return header === "bearer" ? ["authorization", `Bearer ${key}`] : ["x-api-key", key];
}

/**
 * A fetch that sends the newest key in the chosen header, replacing whatever auth header the SDK
 * set. This way the SDK never adds credentials of its own (from the environment or a saved login)
 * to requests bound for a gateway.
 */
export function keyedFetch(key: Key, header: KeyHeader, base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    const [name, value] = keyHeader(header, await key.get());
    headers.set(name, value);
    return base(input, { ...init, headers });
  };
}

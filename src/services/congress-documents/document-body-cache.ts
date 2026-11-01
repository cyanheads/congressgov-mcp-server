/**
 * @fileoverview Process-local cache of decompressed document bodies, so a walk
 * through a multi-window document fetches it once per TTL instead of once per
 * window.
 *
 * Every window streams the whole body, because `totalCharacters` is known only
 * at the end of it. Caching the bytes rather than extracted text keeps the
 * extractor and its input unchanged — a window replayed from cache is the
 * window a fresh fetch returns — and holds each body at one byte per byte with
 * nothing sliced out of it to pin a larger parent.
 *
 * One cache serves every tenant: each body is a public document fetched without
 * credentials from a URL the server resolved and allowlisted itself.
 *
 * @module services/congress-documents/document-body-cache
 */

/** Bytes all entries together may hold; the least recently used entries go first. */
export const BODY_CACHE_MAX_BYTES = 64_000_000;

/**
 * Largest body one entry holds. Clears the largest known body (116th Congress
 * H.R. 133 enrolled as XML, 9,812,888 bytes); a body past it is read as before
 * and never cached.
 */
export const BODY_CACHE_MAX_ENTRY_BYTES = 16_000_000;

/** How long an entry serves, from its insert — inside congress.gov's own `max-age=1800`. */
export const BODY_CACHE_TTL_MS = 10 * 60_000;

/** The bounds one cache enforces. */
export interface BodyCacheLimits {
  maxBytes: number;
  maxEntryBytes: number;
  ttlMs: number;
}

/**
 * The chunks of one body as a fetch streams them, from
 * {@link DocumentBodyCache.capture}. Kept until the body passes the entry
 * ceiling, then dropped, after which nothing more is kept.
 */
export class BodyCapture {
  private byteLength = 0;
  private chunks: Uint8Array[] | null = [];

  constructor(private readonly maxBytes: number) {}

  /** Record the next chunk of the body. */
  add(chunk: Uint8Array): void {
    if (this.chunks === null) return;
    this.byteLength += chunk.byteLength;
    if (this.byteLength > this.maxBytes) this.chunks = null;
    else this.chunks.push(chunk);
  }

  /** The whole body as one buffer it owns, or undefined once it passed the ceiling. */
  toBody(): Uint8Array | undefined {
    if (this.chunks === null) return;
    const body = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }
}

interface Entry {
  body: Uint8Array;
  expiresAt: number;
}

/** LRU over decompressed document bodies, keyed by the server-resolved URL. */
export class DocumentBodyCache {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly limits: BodyCacheLimits = {
      maxBytes: BODY_CACHE_MAX_BYTES,
      maxEntryBytes: BODY_CACHE_MAX_ENTRY_BYTES,
      ttlMs: BODY_CACHE_TTL_MS,
    },
  ) {}

  /** Start capturing a body as it streams, under this cache's entry ceiling. */
  capture(): BodyCapture {
    return new BodyCapture(this.limits.maxEntryBytes);
  }

  /** The body cached for `url`, now the most recently used, or undefined when absent or expired. */
  get(url: string): Uint8Array | undefined {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    if (entry.expiresAt <= Date.now()) {
      this.totalBytes -= entry.body.byteLength;
      return;
    }
    this.entries.set(url, entry);
    return entry.body;
  }

  /**
   * Cache a captured body as one owned buffer, replacing any entry for `url`
   * and evicting expired, then least recently used, entries until it fits. A
   * capture dropped at the entry ceiling inserts nothing.
   */
  insert(url: string, capture: BodyCapture): void {
    const body = capture.toBody();
    if (body === undefined) return;
    this.remove(url);
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
    for (const key of this.entries.keys()) {
      if (this.totalBytes + body.byteLength <= this.limits.maxBytes) break;
      this.remove(key);
    }
    this.entries.set(url, { body, expiresAt: now + this.limits.ttlMs });
    this.totalBytes += body.byteLength;
  }

  private remove(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    this.totalBytes -= entry.body.byteLength;
  }
}

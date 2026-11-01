/**
 * @fileoverview Tests for DocumentBodyCache — the entry ceiling on a capture,
 * one owned buffer per entry, the total-bytes bound with LRU eviction, and the
 * TTL counted from insert.
 * @module tests/services/congress-documents/document-body-cache.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_CACHE_MAX_BYTES,
  BODY_CACHE_MAX_ENTRY_BYTES,
  BODY_CACHE_TTL_MS,
  DocumentBodyCache,
} from '@/services/congress-documents/document-body-cache.js';

const TTL_MS = 60_000;

/** `length` bytes of `fill`. */
function bytes(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** Capture `chunks` and insert them under `url`. */
function put(cache: DocumentBodyCache, url: string, ...chunks: Uint8Array[]): void {
  const capture = cache.capture();
  for (const chunk of chunks) capture.add(chunk);
  cache.insert(url, capture);
}

describe('DocumentBodyCache', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('ships the ruled bounds', () => {
    expect(BODY_CACHE_MAX_BYTES).toBe(64_000_000);
    expect(BODY_CACHE_MAX_ENTRY_BYTES).toBe(16_000_000);
    expect(BODY_CACHE_TTL_MS).toBe(600_000);
    /** The largest known body, H.R. 133 enrolled as XML, fits one entry. */
    expect(BODY_CACHE_MAX_ENTRY_BYTES).toBeGreaterThan(9_812_888);
  });

  it('returns nothing for a url it never cached', () => {
    expect(new DocumentBodyCache().get('https://www.congress.gov/a')).toBeUndefined();
  });

  describe('capture', () => {
    const cache = () =>
      new DocumentBodyCache({ maxBytes: 1_000, maxEntryBytes: 10, ttlMs: TTL_MS });

    it('keeps a body of exactly the entry ceiling, reassembled across chunks', () => {
      const target = cache();
      put(target, 'a', bytes(4, 0x31), bytes(6, 0x32));
      expect(Array.from(target.get('a') ?? [])).toEqual([
        0x31, 0x31, 0x31, 0x31, 0x32, 0x32, 0x32, 0x32, 0x32, 0x32,
      ]);
    });

    it('drops a body one byte past the ceiling, and stays dropped', () => {
      const target = cache();
      put(target, 'a', bytes(6), bytes(5), bytes(0));
      expect(target.get('a')).toBeUndefined();
    });

    it('stores one buffer of its own, not a view onto the chunks it was given', () => {
      const target = cache();
      const backing = new Uint8Array(64).fill(0x7a);
      const view = backing.subarray(8, 13);
      put(target, 'a', view, bytes(3));
      backing.fill(0);

      const body = target.get('a') as Uint8Array;
      expect(body.byteLength).toBe(8);
      expect(body.byteOffset).toBe(0);
      expect(body.buffer.byteLength).toBe(8);
      expect(Array.from(body.subarray(0, 5))).toEqual([0x7a, 0x7a, 0x7a, 0x7a, 0x7a]);
    });
  });

  describe('total bound', () => {
    const cache = () => new DocumentBodyCache({ maxBytes: 100, maxEntryBytes: 60, ttlMs: TTL_MS });

    it('evicts the least recently used entry, not the oldest insert', () => {
      const target = cache();
      put(target, 'a', bytes(40));
      put(target, 'b', bytes(40));
      expect(target.get('a')).toBeDefined();
      put(target, 'c', bytes(40));
      expect(target.get('b')).toBeUndefined();
      expect(target.get('a')).toBeDefined();
      expect(target.get('c')).toBeDefined();
    });

    it('fills to exactly the bound without evicting', () => {
      const target = cache();
      put(target, 'a', bytes(50));
      put(target, 'b', bytes(50));
      expect(target.get('a')).toBeDefined();
      expect(target.get('b')).toBeDefined();
    });

    it('frees the bytes of an entry it replaces', () => {
      const target = cache();
      put(target, 'a', bytes(60));
      put(target, 'a', bytes(60));
      put(target, 'b', bytes(40));
      expect(target.get('a')?.byteLength).toBe(60);
      expect(target.get('b')).toBeDefined();
    });

    it('never holds more than the bound across a long run of inserts', () => {
      const target = cache();
      const sizes = [60, 1, 59, 40, 60, 2, 33, 60, 17, 60, 50, 50, 49, 51, 60];
      const live = new Map<string, number>();
      sizes.forEach((size, i) => {
        put(target, `u${i % 6}`, bytes(size));
        live.set(`u${i % 6}`, size);
        let held = 0;
        for (const url of live.keys()) held += target.get(url)?.byteLength ?? 0;
        expect(held, `after insert ${i}`).toBeLessThanOrEqual(100);
        expect(target.get(`u${i % 6}`)?.byteLength).toBe(size);
      });
    });
  });

  describe('ttl', () => {
    it('serves an entry until the ttl from its insert, not from its last use', () => {
      const target = new DocumentBodyCache({ maxBytes: 100, maxEntryBytes: 60, ttlMs: TTL_MS });
      const start = Date.now();
      put(target, 'a', bytes(10));
      vi.setSystemTime(start + TTL_MS - 1);
      expect(target.get('a')).toBeDefined();
      vi.setSystemTime(start + TTL_MS);
      expect(target.get('a')).toBeUndefined();
    });

    it('drops expired entries before evicting live ones to fit a new body', () => {
      const target = new DocumentBodyCache({ maxBytes: 100, maxEntryBytes: 60, ttlMs: TTL_MS });
      const start = Date.now();
      put(target, 'stale', bytes(50));
      vi.setSystemTime(start + 1_000);
      put(target, 'live', bytes(50));
      /** `stale` becomes the most recently used, so LRU alone would evict `live`. */
      vi.setSystemTime(start + 2_000);
      expect(target.get('stale')).toBeDefined();
      vi.setSystemTime(start + TTL_MS);
      put(target, 'new', bytes(50));
      expect(target.get('live')).toBeDefined();
      expect(target.get('new')).toBeDefined();
      expect(target.get('stale')).toBeUndefined();
    });

    it('frees the bytes of an entry that expires on read', () => {
      const target = new DocumentBodyCache({ maxBytes: 100, maxEntryBytes: 60, ttlMs: TTL_MS });
      const start = Date.now();
      put(target, 'a', bytes(60));
      vi.setSystemTime(start + TTL_MS);
      expect(target.get('a')).toBeUndefined();
      put(target, 'b', bytes(60));
      put(target, 'c', bytes(40));
      expect(target.get('b')?.byteLength).toBe(60);
      expect(target.get('c')?.byteLength).toBe(40);
    });
  });

  it('enforces the ruled bounds by default: 64 MB in all, 16 MB per body', () => {
    const target = new DocumentBodyCache();
    for (const url of ['a', 'b', 'c', 'd']) put(target, url, new Uint8Array(16_000_000));
    for (const url of ['a', 'b', 'c', 'd']) expect(target.get(url)?.byteLength).toBe(16_000_000);
    put(target, 'e', bytes(1));
    expect(target.get('a')?.byteLength).toBeUndefined();
    expect(target.get('e')?.byteLength).toBe(1);
    put(target, 'f', new Uint8Array(16_000_001));
    expect(target.get('f')?.byteLength).toBeUndefined();
  });
});

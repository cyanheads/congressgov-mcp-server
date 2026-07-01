/**
 * @fileoverview Unit tests for the Congress bill mirror service — drives the sync
 * generator against a mocked Congress API (a few bills + a couple summaries),
 * asserts the two sources merge into one row per bill, and verifies FTS hits over
 * both title and summary (including a title-only bill with a null summary).
 * @module tests/services/congress-mirror/congress-mirror-service
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CongressMirrorService } from '@/services/congress-mirror/congress-mirror-service.js';
import type { MirrorApi } from '@/services/congress-mirror/ingest.js';

/** A mocked Congress API returning fixed bill + summary pages (single congress). */
function makeApi(
  bills: Record<string, unknown>[],
  summaries: Record<string, unknown>[],
): MirrorApi {
  return {
    async listBills(params) {
      const offset = params.offset ?? 0;
      return offset > 0
        ? { data: [], pagination: { count: bills.length, nextOffset: null } }
        : { data: bills, pagination: { count: bills.length, nextOffset: null } };
    },
    async listSummaries(params) {
      const offset = params.offset ?? 0;
      return offset > 0
        ? { data: [], pagination: { count: summaries.length, nextOffset: null } }
        : { data: summaries, pagination: { count: summaries.length, nextOffset: null } };
    },
  };
}

const BILLS: Record<string, unknown>[] = [
  {
    congress: 119,
    type: 'hr',
    number: 1,
    title: 'Semiconductor Export Control Act',
    originChamber: 'House',
    latestAction: {
      actionDate: '2026-01-05',
      text: 'Referred to the Committee on Foreign Affairs',
    },
    updateDate: '2026-01-10',
  },
  {
    congress: 119,
    type: 's',
    number: 2,
    title: 'Clean Water Restoration Act',
    originChamber: 'Senate',
    latestAction: { actionDate: '2026-01-18', text: 'Read twice and referred to committee' },
    updateDate: '2026-02-01',
  },
  {
    congress: 119,
    type: 'hr',
    number: 3,
    title: 'Farm Subsidy Reform Act',
    originChamber: 'House',
    latestAction: { actionDate: '2026-02-20', text: 'Introduced in House' },
    updateDate: '2026-03-01',
  },
];

const SUMMARIES: Record<string, unknown>[] = [
  {
    bill: { congress: 119, type: 'hr', number: 1, title: 'Semiconductor Export Control Act' },
    text: '<p>This bill restricts the <strong>export</strong> of advanced semiconductor manufacturing equipment to certain foreign countries.</p>',
    updateDate: '2026-01-08',
  },
  {
    bill: { congress: 119, type: 's', number: 2, title: 'Clean Water Restoration Act' },
    text: '<p>Restores Clean Water Act protections for wetlands and intermittent streams.</p>',
    updateDate: '2026-01-20',
  },
];

describe('CongressMirrorService', () => {
  let dbPath: string;
  let service: CongressMirrorService;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `congress-mirror-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`,
    );
    service = new CongressMirrorService({
      mirrorPath: dbPath,
      congresses: [119],
      getApi: () => makeApi(BILLS, SUMMARIES),
    });
  });

  afterEach(async () => {
    await service.mirrorInstance.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const path = dbPath + suffix;
      if (existsSync(path)) rmSync(path, { force: true });
    }
  });

  it('is not ready before an initial sync completes', async () => {
    expect(await service.ready()).toBe(false);
  });

  it('merges bills + summaries into one row per bill on init', async () => {
    const result = await service.mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    expect(result.recordsApplied).toBe(3);
    expect(result.total).toBe(3);
    expect(await service.ready()).toBe(true);

    const [merged] = await service.mirrorInstance.getByIds(['119/hr/1']);
    expect(merged).toBeDefined();
    expect(merged?.title).toBe('Semiconductor Export Control Act');
    // Summary HTML-stripped to plain text (tags gone, entities decoded).
    expect(String(merged?.summary)).toContain('advanced semiconductor manufacturing equipment');
    expect(String(merged?.summary)).not.toContain('<strong>');
    expect(merged?.originChamber).toBe('House');
    expect(merged?.updateDate).toBe('2026-01-10');

    // A bill with no CRS summary is still mirrored, with a null summary.
    const [noSummary] = await service.mirrorInstance.getByIds(['119/hr/3']);
    expect(noSummary?.title).toBe('Farm Subsidy Reform Act');
    expect(noSummary?.summary).toBeNull();
  });

  it('finds a title match', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    const page = await service.search({ query: 'semiconductor', limit: 20, offset: 0 }, ctx);
    expect(page.total).toBe(1);
    expect(page.items[0]?.billId).toBe('119/hr/1');
    expect(page.items[0]?.title).toBe('Semiconductor Export Control Act');
    expect(page.items[0]?.summaryPreview).toContain('semiconductor');
  });

  it('finds a summary-only match (term absent from the title)', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    const page = await service.search({ query: 'wetlands', limit: 20, offset: 0 }, ctx);
    expect(page.total).toBe(1);
    expect(page.items[0]?.billId).toBe('119/s/2');
  });

  it('finds a title-only bill with no summary and omits the preview', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    const page = await service.search({ query: 'farm subsidy', limit: 20, offset: 0 }, ctx);
    expect(page.total).toBe(1);
    expect(page.items[0]?.billId).toBe('119/hr/3');
    expect(page.items[0]?.summaryPreview).toBeUndefined();
  });

  it('applies the billType filter', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    expect(
      (await service.search({ query: 'water', billType: 's', limit: 20, offset: 0 }, ctx)).total,
    ).toBe(1);
    expect(
      (await service.search({ query: 'water', billType: 'hr', limit: 20, offset: 0 }, ctx)).total,
    ).toBe(0);
  });

  it('returns an empty page for a non-matching query', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    const page = await service.search({ query: 'zzzznotarealword', limit: 20, offset: 0 }, ctx);
    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(0);
  });

  it('treats a punctuation-only query as no match, not a SQLite error', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    // A raw pass-through of "-" would raise an FTS5 syntax error; tokenize+quote avoids it.
    const page = await service.search({ query: ' - ', limit: 20, offset: 0 }, ctx);
    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(0);
  });
});

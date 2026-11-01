/**
 * @fileoverview Unit tests for the Congress bill mirror service — drives the sync
 * generator against a mocked Congress API (a few bills + a couple summaries),
 * asserts the two sources merge into one row per bill, verifies FTS hits over
 * both title and summary (including a title-only bill with a null summary), and
 * covers the summaries date window, refresh, the refresh checkpoint, and the
 * schema-version-2 migration.
 * @module tests/services/congress-mirror/congress-mirror-service
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CongressMirrorService } from '@/services/congress-mirror/congress-mirror-service.js';
import { createCongressBillIngester, type MirrorApi } from '@/services/congress-mirror/ingest.js';
import { billStoreSpec } from '@/services/congress-mirror/schema.js';

type ListBillsParams = Parameters<MirrorApi['listBills']>[0];
type ListSummariesParams = Parameters<MirrorApi['listSummaries']>[0];
type Row = Record<string, unknown>;

/** A mocked API that records the params of every call. */
interface TrackedApi extends MirrorApi {
  calls: { bills: ListBillsParams[]; summaries: ListSummariesParams[] };
}

/** One `offset`/`limit` page of `rows`, with `nextOffset` set while rows remain. */
function page(rows: Row[], params: { limit?: number | undefined; offset?: number | undefined }) {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 20;
  return {
    data: rows.slice(offset, offset + limit),
    pagination: {
      count: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    },
  };
}

/**
 * A mocked Congress API over fixed bill + summary rows, filtered by congress and
 * paged by `offset`/`limit`. Both lists honor `fromDateTime` the way Congress.gov
 * does: the summaries list without one holds only the last day's updates (none
 * here) and with one holds every summary updated since, newest first; the bill
 * list filters on `updateDate` and sorts oldest first (the ingester's
 * `sort=updateDate asc`). The row arrays are read on every call, so a test can
 * edit them between syncs.
 */
function makeApi(bills: Row[], summaries: Row[]): TrackedApi {
  const calls: TrackedApi['calls'] = { bills: [], summaries: [] };
  const stamp = (row: Row) => String(row.updateDate);
  return {
    calls,
    async listBills(params) {
      calls.bills.push(params);
      const from = params.fromDateTime?.slice(0, 10);
      const rows = bills
        .filter((b) => b.congress === params.congress && (!from || stamp(b) >= from))
        .sort((a, b) => stamp(a).localeCompare(stamp(b)));
      return page(rows, params);
    },
    async listSummaries(params) {
      calls.summaries.push(params);
      const from = params.fromDateTime;
      const rows = from
        ? summaries
            .filter((s) => (s.bill as Row).congress === params.congress && stamp(s) >= from)
            .sort((a, b) => stamp(b).localeCompare(stamp(a)))
        : [];
      return page(rows, params);
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

const BILLS_118: Row[] = [
  {
    congress: 118,
    type: 'hr',
    number: 5,
    title: 'Rural Broadband Expansion Act',
    originChamber: 'House',
    latestAction: { actionDate: '2024-05-10', text: 'Referred to committee' },
    updateDate: '2024-06-01',
  },
];

const SUMMARIES_118: Row[] = [
  {
    bill: { congress: 118, type: 'hr', number: 5 },
    text: '<p>Funds broadband deployment in rural counties.</p>',
    updateDate: '2024-05-20T10:00:00Z',
  },
];

describe('CongressMirrorService', () => {
  let dbPath: string;
  let service: CongressMirrorService;
  /** The API the service's sync reads — reassign it before a sync to swap behavior. */
  let api: TrackedApi;

  /** Replace the default single-congress service with one over `congresses`. */
  async function openService(congresses: number[]): Promise<void> {
    await service.mirrorInstance.close();
    service = new CongressMirrorService({ mirrorPath: dbPath, congresses, getApi: () => api });
  }

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `congress-mirror-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`,
    );
    api = makeApi(BILLS, SUMMARIES);
    service = new CongressMirrorService({
      mirrorPath: dbPath,
      congresses: [119],
      getApi: () => api,
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

  it("requests every summaries page from its congress's first day, with no end, on init and refresh", async () => {
    // 300 newer summaries push the two real 119 summaries onto the second page.
    const filler: Row[] = Array.from({ length: 300 }, (_, i) => ({
      bill: { congress: 119, type: 'hr', number: 1000 + i },
      text: `<p>Filler summary ${i}.</p>`,
      updateDate: '2026-05-01T00:00:00Z',
    }));
    api = makeApi([...BILLS_118, ...BILLS], [...SUMMARIES_118, ...SUMMARIES, ...filler]);
    await openService([118, 119]);

    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    await service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) });

    const walk = [
      { congress: 118, limit: 250, offset: 0, fromDateTime: '2023-01-01T00:00:00Z' },
      { congress: 119, limit: 250, offset: 0, fromDateTime: '2025-01-01T00:00:00Z' },
      { congress: 119, limit: 250, offset: 250, fromDateTime: '2025-01-01T00:00:00Z' },
    ];
    expect(api.calls.summaries).toStrictEqual([...walk, ...walk]);

    const rows = await service.mirrorInstance.getByIds(['118/hr/5', '119/hr/1', '119/s/2']);
    expect(rows.map((r) => r.summary)).toEqual([
      'Funds broadband deployment in rural counties.',
      expect.stringContaining('advanced semiconductor manufacturing equipment'),
      'Restores Clean Water Act protections for wetlands and intermittent streams.',
    ]);
  });

  it('keeps stored summaries on bills a refresh re-emits', async () => {
    const bills = BILLS.map((b) => ({ ...b }));
    api = makeApi(bills, SUMMARIES);
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

    const hr1 = bills[0] as Row;
    hr1.updateDate = '2026-04-01';
    hr1.title = 'Semiconductor Export Control Act of 2026';
    const result = await service.mirrorInstance.runSync({
      mode: 'refresh',
      signal: AbortSignal.timeout(60_000),
    });

    expect(api.calls.bills.at(-1)).toMatchObject({ fromDateTime: '2026-03-01T00:00:00Z' });
    // The inclusive re-scan re-emits hr/3 (updated on the checkpoint day) and the bumped hr/1.
    expect(result.recordsApplied).toBe(2);
    const [stored] = await service.mirrorInstance.getByIds(['119/hr/1']);
    expect(stored?.title).toBe('Semiconductor Export Control Act of 2026');
    expect(String(stored?.summary)).toContain('advanced semiconductor manufacturing equipment');
  });

  it('opens a fresh store at schema version 2 with no checkpoint; init sets one', async () => {
    const db = await service.mirrorInstance.raw();
    const version = db.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get();
    expect(version?.v).toBe(2);
    expect((await service.mirrorInstance.status()).checkpoint).toBeUndefined();

    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

    expect(await service.mirrorInstance.status()).toMatchObject({
      ready: true,
      status: 'complete',
      checkpoint: '2026-03-01',
      total: 3,
    });
  });

  it('migrates a version-1 store: clears the checkpoint, keeps readiness, and the next refresh walks every bill', async () => {
    // A store as 0.9.0 left it: complete, checkpointed, every summary null.
    const v1 = sqliteMirrorStore({ ...billStoreSpec(dbPath), version: 1, migrations: [] });
    await v1.applyBatch(
      BILLS.map((b) => ({
        billId: `119/${b.type}/${b.number}`,
        congress: 119,
        billType: String(b.type),
        billNumber: Number(b.number),
        title: String(b.title),
        summary: null,
        originChamber: String(b.originChamber),
        latestActionDate: null,
        latestActionText: null,
        updateDate: String(b.updateDate),
      })),
      [],
    );
    await v1.writeState({
      status: 'complete',
      checkpoint: '2026-03-01',
      completedAt: '2026-06-01T00:00:00.000Z',
      total: 3,
    });
    await v1.close();

    const migrated = await service.mirrorInstance.status();
    expect(migrated).toMatchObject({
      ready: true,
      status: 'complete',
      completedAt: '2026-06-01T00:00:00.000Z',
      total: 3,
    });
    expect(migrated.checkpoint).toBeUndefined();
    const db = await service.mirrorInstance.raw();
    const version = db.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get();
    expect(version?.v).toBe(2);

    await service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) });

    expect(api.calls.bills).toStrictEqual([
      { congress: 119, sort: 'updateDate asc', limit: 250, offset: 0 },
    ]);
    expect(await service.ready()).toBe(true);
    const rows = await service.mirrorInstance.getByIds(['119/hr/1', '119/s/2', '119/hr/3']);
    expect(rows.map((r) => r.summary !== null)).toEqual([true, true, false]);
  });

  it('keeps the stored checkpoint when a refresh fails partway, so the retry re-walks the window', async () => {
    const bills = [...BILLS_118, ...BILLS].map((b) => ({ ...b }));
    const healthy = makeApi(bills, [...SUMMARIES_118, ...SUMMARIES]);
    api = healthy;
    await openService([118, 119]);
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01');

    // 118 gains a newer update than anything 119 has, then 119's bill list goes down.
    (bills[0] as Row).updateDate = '2026-05-01';
    bills.push({
      congress: 119,
      type: 'hr',
      number: 4,
      title: 'Wildfire Mitigation Act',
      originChamber: 'House',
      latestAction: { actionDate: '2026-03-20', text: 'Introduced in House' },
      updateDate: '2026-04-01',
    });
    api = {
      ...healthy,
      async listBills(params) {
        if (params.congress === 119) throw new Error('Congress.gov API returned HTTP 503.');
        return healthy.listBills(params);
      },
    };
    await expect(
      service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) }),
    ).rejects.toThrow('HTTP 503');
    expect(await service.mirrorInstance.status()).toMatchObject({
      status: 'error',
      ready: true,
      checkpoint: '2026-03-01',
    });

    api = healthy;
    await service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) });

    expect(healthy.calls.bills.at(-1)).toMatchObject({
      congress: 119,
      fromDateTime: '2026-03-01T00:00:00Z',
    });
    const [hr4] = await service.mirrorInstance.getByIds(['119/hr/4']);
    expect(hr4?.title).toBe('Wildfire Mitigation Act');
    expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-05-01');
  });

  /** `count` congress-119 bills, the i-th updated on `updateDate(i)`. */
  const bills119 = (count: number, updateDate: (i: number) => string): Row[] =>
    Array.from({ length: count }, (_, i) => ({
      congress: 119,
      type: 'hr',
      number: 2000 + i,
      title: `Bill ${i}`,
      originChamber: 'House',
      updateDate: updateDate(i),
    }));

  /** A healthy API whose signal aborts when congress 119's second bill page is requested. */
  function cancelledAtSecondPage(controller: AbortController): TrackedApi {
    const healthy = makeApi([...BILLS_118, ...bills119(300, () => '2026-02-01')], []);
    return {
      ...healthy,
      async listBills(params) {
        if (params.congress === 119 && params.offset === 250) controller.abort();
        return healthy.listBills(params);
      },
    };
  }

  it('yields the same pages as before, the checkpoint riding the final page only', async () => {
    const day = (i: number) => `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`;
    api = makeApi([...BILLS_118, ...bills119(300, day)], []);
    const sync = createCongressBillIngester(() => api, [118, 119]);
    const pages: Array<{ size: number; checkpoint?: string }> = [];
    for await (const page of sync({ mode: 'init', signal: new AbortController().signal })) {
      pages.push({
        size: page.records.length,
        ...(page.checkpoint ? { checkpoint: page.checkpoint } : {}),
      });
    }
    expect(pages).toEqual([{ size: 1 }, { size: 250 }, { size: 50, checkpoint: '2026-02-28' }]);
  });

  it('yields no checkpoint from a walk cancelled during its last congress', async () => {
    const controller = new AbortController();
    const sync = createCongressBillIngester(() => cancelledAtSecondPage(controller), [118, 119]);
    const checkpoints: Array<string | undefined> = [];
    for await (const page of sync({ mode: 'init', signal: controller.signal })) {
      checkpoints.push(page.checkpoint);
    }
    expect(checkpoints).toEqual([undefined, undefined]);
  });

  it('stores no checkpoint from a run cancelled partway', async () => {
    const controller = new AbortController();
    api = cancelledAtSecondPage(controller);
    await openService([118, 119]);
    await expect(
      service.mirrorInstance.runSync({ mode: 'init', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await service.mirrorInstance.status()).checkpoint).toBeUndefined();
  });
});

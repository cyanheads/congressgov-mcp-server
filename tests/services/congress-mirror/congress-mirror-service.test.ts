/**
 * @fileoverview Unit tests for the Congress bill mirror service — drives the sync
 * generator against a mocked Congress API whose bill list models the live one
 * (`fake-bill-list.ts`: second-resolution update times with ties, date-only rows,
 * exclusive bounds, tie order varying per request), asserts the two sources merge
 * into one row per bill, verifies FTS hits over both title and summary (including
 * a title-only bill with a null summary), and covers the summaries date window,
 * the bill walk (cursor days and halved windows, never an offset), refresh, the
 * refresh checkpoint and the congresses it covers, the mirrored-congress read, and
 * the store-spec migrations.
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
import { type FakeBill, fakeBills, listBillsPage, plusSeconds } from './fake-bill-list.js';

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
 * A mocked Congress API over fixed bill + summary rows. The bill list is the
 * live-shaped fake (`listBillsPage`). The summaries list honors `fromDateTime`
 * the way Congress.gov does: without one it holds only the last day's updates
 * (none here), with one every summary updated since, newest first, paged by
 * `offset`/`limit`. The arrays are read on every call, so a test can edit them
 * between syncs.
 */
function makeApi(bills: FakeBill[], summaries: Row[]): TrackedApi {
  const calls: TrackedApi['calls'] = { bills: [], summaries: [] };
  const stamp = (row: Row) => String(row.updateDate);
  return {
    calls,
    async listBills(params) {
      calls.bills.push(params);
      return listBillsPage(bills, params);
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

const BILLS: FakeBill[] = [
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
    updatedAt: '2026-01-10T15:04:05Z',
  },
  {
    congress: 119,
    type: 's',
    number: 2,
    title: 'Clean Water Restoration Act',
    originChamber: 'Senate',
    latestAction: { actionDate: '2026-01-18', text: 'Read twice and referred to committee' },
    updatedAt: '2026-02-01T09:30:00Z',
  },
  {
    congress: 119,
    type: 'hr',
    number: 3,
    title: 'Farm Subsidy Reform Act',
    originChamber: 'House',
    latestAction: { actionDate: '2026-02-20', text: 'Introduced in House' },
    updatedAt: '2026-03-01T18:45:12Z',
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

const BILLS_118: FakeBill[] = [
  {
    congress: 118,
    type: 'hr',
    number: 5,
    title: 'Rural Broadband Expansion Act',
    originChamber: 'House',
    latestAction: { actionDate: '2024-05-10', text: 'Referred to committee' },
    updatedAt: '2024-06-01T11:00:00Z',
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

    const hr1 = bills[0] as FakeBill;
    hr1.updatedAt = '2026-04-01T08:00:00Z';
    hr1.title = 'Semiconductor Export Control Act of 2026';
    const result = await service.mirrorInstance.runSync({
      mode: 'refresh',
      signal: AbortSignal.timeout(60_000),
    });

    expect(api.calls.bills.at(-1)).toMatchObject({ fromDateTime: '2026-02-28T23:59:59Z' });
    // The re-scan of the checkpoint day re-emits hr/3 (updated on the checkpoint day) and the bumped hr/1.
    expect(result.recordsApplied).toBe(2);
    const [stored] = await service.mirrorInstance.getByIds(['119/hr/1']);
    expect(stored?.title).toBe('Semiconductor Export Control Act of 2026');
    expect(String(stored?.summary)).toContain('advanced semiconductor manufacturing equipment');
  });

  it('opens a fresh store at schema version 3 with no checkpoint; init sets one', async () => {
    const db = await service.mirrorInstance.raw();
    const version = db.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get();
    expect(version?.v).toBe(3);
    expect((await service.mirrorInstance.status()).checkpoint).toBeUndefined();

    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

    expect(await service.mirrorInstance.status()).toMatchObject({
      ready: true,
      status: 'complete',
      checkpoint: '2026-03-01|119',
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
        updateDate: b.updatedAt.slice(0, 10),
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
    expect(version?.v).toBe(3);

    await service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) });

    expect(api.calls.bills).toStrictEqual([
      { congress: 119, sort: 'updateDate asc', limit: 250, fromDateTime: '2024-12-31T23:59:59Z' },
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
    expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01|119,118');

    // 118 gains a newer update than anything 119 has, then 119's bill list goes down.
    (bills[0] as FakeBill).updatedAt = '2026-05-01T10:00:00Z';
    bills.push({
      congress: 119,
      type: 'hr',
      number: 4,
      title: 'Wildfire Mitigation Act',
      originChamber: 'House',
      latestAction: { actionDate: '2026-03-20', text: 'Introduced in House' },
      updatedAt: '2026-04-01T10:00:00Z',
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
      checkpoint: '2026-03-01|119,118',
    });

    api = healthy;
    await service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) });

    expect(healthy.calls.bills.at(-1)).toMatchObject({
      congress: 119,
      fromDateTime: '2026-02-28T23:59:59Z',
    });
    const [hr4] = await service.mirrorInstance.getByIds(['119/hr/4']);
    expect(hr4?.title).toBe('Wildfire Mitigation Act');
    expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-05-01|119,118');
  });

  /** `count` congress-119 bills, the i-th updated at `updatedAt(i)`. */
  const bills119 = (count: number, updatedAt: (i: number) => string): FakeBill[] =>
    fakeBills(119, count, 2000, updatedAt, (i) => `Bill ${i}`);

  /**
   * A healthy API whose signal aborts when congress 119's second bill-list request
   * is made: 300 bills, 100 a day over three days, so the first request returns a
   * page the walk keeps part of before the second request.
   */
  function cancelledAtSecondPage(controller: AbortController): TrackedApi {
    const spread = (i: number) =>
      plusSeconds('2026-02-01T00:00:00Z', Math.floor(i / 100) * 86_400 + i);
    const healthy = makeApi([...BILLS_118, ...bills119(300, spread)], []);
    let requests119 = 0;
    return {
      ...healthy,
      async listBills(params) {
        if (params.congress === 119 && ++requests119 === 2) controller.abort();
        return healthy.listBills(params);
      },
    };
  }

  it('yields the checkpoint on the final page only', async () => {
    const day = (i: number) => `2026-02-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00Z`;
    api = makeApi([...BILLS_118, ...bills119(300, day)], []);
    const sync = createCongressBillIngester(() => api, [118, 119]);
    const pages: Array<{ size: number; checkpoint?: string }> = [];
    for await (const page of sync({ mode: 'init', signal: new AbortController().signal })) {
      pages.push({
        size: page.records.length,
        ...(page.checkpoint ? { checkpoint: page.checkpoint } : {}),
      });
    }
    // 119's first request returns days 1–23; the walk keeps days 1–22 and re-reads day 23 on.
    expect(pages).toEqual([
      { size: 1 },
      { size: 240 },
      { size: 60, checkpoint: '2026-02-28|119,118' },
    ]);
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

  describe('bill walk over tied update times (#92)', () => {
    /**
     * Congress 119 shaped like the live list, 1,011 bills: 200 on distinct seconds
     * through 2025-08; on 2026-08-10, 81 tied at 11:58:36Z and 100 after them; on
     * 2026-09-19, 150 spread through the morning and 450 packed four to a second
     * from 12:00:00Z, so that day's halving runs several levels deep; and 30 on
     * 2026-10-02 in ties of ten. Offset pages of 250 split the 81-bill tie (at 250),
     * a four-bill tie (at 750), and a ten-bill tie (at 1,000).
     */
    function liveLikeBills(): FakeBill[] {
      return [
        ...fakeBills(119, 200, 1, (i) => plusSeconds('2025-02-01T00:00:00Z', i * 86_401)),
        ...fakeBills(119, 81, 1000, () => '2026-08-10T11:58:36Z'),
        ...fakeBills(119, 100, 2000, (i) => plusSeconds('2026-08-10T12:00:00Z', i)),
        ...fakeBills(119, 150, 3000, (i) => plusSeconds('2026-09-19T00:00:00Z', i * 240)),
        ...fakeBills(119, 450, 4000, (i) => plusSeconds('2026-09-19T12:00:00Z', Math.floor(i / 4))),
        ...fakeBills(119, 30, 5000, (i) => plusSeconds('2026-10-02T09:00:00Z', Math.floor(i / 10))),
      ];
    }

    /** Every stored row's billId and title, keyed by billId. */
    async function storedTitles(): Promise<Map<string, unknown>> {
      const db = await service.mirrorInstance.raw();
      const rows = db
        .prepare<{ billId: string; title: unknown }>('SELECT billId, title FROM bills')
        .all();
      return new Map(rows.map((r) => [r.billId, r.title]));
    }

    /** Seconds between a bill-list call's two bounds; Infinity when it has no upper bound. */
    const windowSeconds = (call: ListBillsParams) =>
      call.toDateTime && call.fromDateTime
        ? (Date.parse(call.toDateTime) - Date.parse(call.fromDateTime)) / 1000
        : Number.POSITIVE_INFINITY;

    it('init stores every bill exactly once, walking a day over 250 in halved windows and never paging by offset', async () => {
      const bills = liveLikeBills();
      api = makeApi(bills, []);
      const result = await service.mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });

      const stored = await storedTitles();
      expect(stored.size).toBe(1011);
      expect(bills.filter((b) => !stored.has(`119/hr/${b.number}`))).toEqual([]);
      expect(result.total).toBe(1011);
      // One walk, one write per bill: no bill re-emitted by a later page.
      expect(result.recordsApplied).toBe(1011);

      expect(api.calls.bills.every((call) => (call.offset ?? 0) === 0)).toBe(true);
      expect(api.calls.bills.every((call) => call.limit === 250)).toBe(true);
      expect(api.calls.bills[0]).toMatchObject({ fromDateTime: '2024-12-31T23:59:59Z' });
      expect(api.calls.bills[0]?.toDateTime).toBeUndefined();
      // The 2026-09-19 day window, then halves of it down past a quarter of a day.
      expect(api.calls.bills).toContainEqual(
        expect.objectContaining({
          fromDateTime: '2026-09-18T23:59:59Z',
          toDateTime: '2026-09-20T00:00:00Z',
        }),
      );
      expect(Math.min(...api.calls.bills.map(windowSeconds))).toBeLessThan(6 * 3600);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-10-02|119');
    });

    it('refresh re-walks from one second before the checkpoint day and stores every bill updated since', async () => {
      const bills = liveLikeBills();
      api = makeApi(bills, []);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

      /** 620 bills move past the checkpoint: 200 to distinct seconds on 2026-10-15, 120 tied at
       * 2026-10-20T08:00:00Z (split by the old walk's offset-250 page), 300 three to a second
       * on 2026-10-21 (a day over 250). */
      const moved: FakeBill[] = [];
      const move = (number: number, updatedAt: string) => {
        const bill = bills.find((b) => b.number === number) as FakeBill;
        bill.updatedAt = updatedAt;
        bill.title = `Moved ${number}`;
        moved.push(bill);
      };
      for (let i = 0; i < 200; i++) move(1 + i, plusSeconds('2026-10-15T00:00:00Z', i * 60));
      for (let i = 0; i < 120; i++) move(4000 + i, '2026-10-20T08:00:00Z');
      for (let i = 0; i < 300; i++) {
        move(4120 + i, plusSeconds('2026-10-21T06:00:00Z', Math.floor(i / 3)));
      }
      const firstRefreshCall = api.calls.bills.length;

      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });

      const stored = await storedTitles();
      expect(
        moved
          .filter((b) => stored.get(`119/hr/${b.number}`) !== `Moved ${b.number}`)
          .map((b) => b.number),
      ).toEqual([]);
      expect(stored.size).toBe(1011);
      const refreshCalls = api.calls.bills.slice(firstRefreshCall);
      expect(refreshCalls[0]).toMatchObject({
        congress: 119,
        fromDateTime: '2026-10-01T23:59:59Z',
      });
      expect(refreshCalls.every((call) => (call.offset ?? 0) === 0)).toBe(true);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-10-21|119');
    });

    it('fails the sync on a one-second window over 250 bills and leaves the stored checkpoint unchanged', async () => {
      const bills = BILLS.map((b) => ({ ...b }));
      api = makeApi(bills, []);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

      bills.push(...fakeBills(119, 251, 7000, () => '2026-04-01T12:00:00Z'));
      await expect(
        service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) }),
      ).rejects.toThrow(/251 bills .*2026-04-01T12:00:00Z/);
      expect(await service.mirrorInstance.status()).toMatchObject({
        status: 'error',
        ready: true,
        checkpoint: '2026-03-01|119',
      });
    });

    it('splits a two-second window over 250 into its seconds instead of failing', async () => {
      const bills = [
        ...fakeBills(119, 200, 7000, () => '2026-04-01T12:00:00Z'),
        ...fakeBills(119, 200, 8000, () => '2026-04-01T12:00:01Z'),
      ];
      api = makeApi(bills, []);
      const result = await service.mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });

      expect((await storedTitles()).size).toBe(400);
      expect(result.recordsApplied).toBe(400);
      expect(api.calls.bills).toContainEqual(
        expect.objectContaining({
          fromDateTime: '2026-04-01T11:59:59Z',
          toDateTime: '2026-04-01T12:00:01Z',
        }),
      );
    });
  });

  describe('refresh coverage of configured congresses (#104)', () => {
    it("walks a congress the checkpoint has never covered from that congress's start", async () => {
      api = makeApi([...BILLS_118, ...BILLS], [...SUMMARIES_118, ...SUMMARIES]);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

      await openService([118, 119]);
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });

      expect(api.calls.bills.slice(-2)).toEqual([
        expect.objectContaining({ congress: 118, fromDateTime: '2022-12-31T23:59:59Z' }),
        expect.objectContaining({ congress: 119, fromDateTime: '2026-02-28T23:59:59Z' }),
      ]);
      const [hr5] = await service.mirrorInstance.getByIds(['118/hr/5']);
      expect(hr5?.title).toBe('Rural Broadband Expansion Act');
      expect(hr5?.summary).toBe('Funds broadband deployment in rural counties.');
      // Nothing newer than the stored date: the checkpoint gains 118 and keeps 119.
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01|119,118');
    });

    it('leaves the checkpoint unchanged when the backfill fails, and the retry backfills from the start', async () => {
      const healthy = makeApi([...BILLS_118, ...BILLS], []);
      api = healthy;
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
      const covering119 = (await service.mirrorInstance.status()).checkpoint;

      await openService([118, 119]);
      api = {
        ...healthy,
        async listBills(params) {
          if (params.congress === 118) throw new Error('Congress.gov API returned HTTP 503.');
          return healthy.listBills(params);
        },
      };
      await expect(
        service.mirrorInstance.runSync({ mode: 'refresh', signal: AbortSignal.timeout(60_000) }),
      ).rejects.toThrow('HTTP 503');
      expect((await service.mirrorInstance.status()).checkpoint).toBe(covering119);

      api = healthy;
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });

      expect(healthy.calls.bills.at(-2)).toMatchObject({
        congress: 118,
        fromDateTime: '2022-12-31T23:59:59Z',
      });
      expect((await service.mirrorInstance.getByIds(['118/hr/5']))[0]?.title).toBe(
        'Rural Broadband Expansion Act',
      );
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01|119,118');
    });

    it('walks a congress from its start again once a newer checkpoint was written without it', async () => {
      const bills = [...BILLS_118, ...BILLS].map((b) => ({ ...b }));
      api = makeApi(bills, []);
      await openService([118, 119]);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

      // 118 leaves the configuration; a refresh sees a newer 119 update.
      await openService([119]);
      (bills[1] as FakeBill).updatedAt = '2026-04-01T08:00:00Z';
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });

      await openService([118, 119]);
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });
      expect(api.calls.bills.slice(-2)).toEqual([
        expect.objectContaining({ congress: 118, fromDateTime: '2022-12-31T23:59:59Z' }),
        expect.objectContaining({ congress: 119, fromDateTime: '2026-03-31T23:59:59Z' }),
      ]);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-04-01|119,118');
    });

    it('keeps a congress it did not walk in the checkpoint while the checkpoint date holds', async () => {
      api = makeApi([...BILLS_118, ...BILLS], []);
      await openService([118, 119]);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });

      await openService([119]);
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01|119,118');

      await openService([118, 119]);
      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });
      expect(api.calls.bills.slice(-2)).toEqual([
        expect.objectContaining({ congress: 118, fromDateTime: '2026-02-28T23:59:59Z' }),
        expect.objectContaining({ congress: 119, fromDateTime: '2026-02-28T23:59:59Z' }),
      ]);
    });

    it('migrates a version-2 store: clears its date-only checkpoint, keeps readiness, and the next refresh walks every congress from its start', async () => {
      const v2 = sqliteMirrorStore({ ...billStoreSpec(dbPath), version: 2, migrations: [] });
      await v2.applyBatch(
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
          updateDate: b.updatedAt.slice(0, 10),
        })),
        [],
      );
      await v2.writeState({
        status: 'complete',
        checkpoint: '2026-03-01',
        completedAt: '2026-11-01T00:00:00.000Z',
        total: 3,
      });
      await v2.close();

      const migrated = await service.mirrorInstance.status();
      expect(migrated).toMatchObject({ ready: true, status: 'complete', total: 3 });
      expect(migrated.checkpoint).toBeUndefined();
      const db = await service.mirrorInstance.raw();
      const version = db
        .prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version')
        .get();
      expect(version?.v).toBe(3);

      await service.mirrorInstance.runSync({
        mode: 'refresh',
        signal: AbortSignal.timeout(60_000),
      });
      expect(api.calls.bills).toStrictEqual([
        { congress: 119, sort: 'updateDate asc', limit: 250, fromDateTime: '2024-12-31T23:59:59Z' },
      ]);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2026-03-01|119');
    });
  });

  describe('mirroredCongresses (#99)', () => {
    it('reads the congresses the store holds rows for, ascending, whatever the configuration says', async () => {
      api = makeApi([...BILLS_118, ...BILLS], []);
      await openService([119, 118]);
      expect(await service.mirroredCongresses()).toEqual([]);

      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
      expect(await service.mirroredCongresses()).toEqual([118, 119]);

      await openService([117]);
      expect(await service.mirroredCongresses()).toEqual([118, 119]);
    });
  });
});

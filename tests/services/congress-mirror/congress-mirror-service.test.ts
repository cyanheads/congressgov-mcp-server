/**
 * @fileoverview Unit tests for the Congress bill mirror service — drives the sync
 * generator against a mocked Congress API whose bill list models the live one
 * (`fake-bill-list.ts`: second-resolution update times with ties, date-only rows,
 * exclusive bounds, tie order varying per request), asserts the two sources merge
 * into one row per bill, verifies FTS hits over both title and summary (including
 * a title-only bill with a null summary), and covers the summaries date window,
 * the bill walk (cursor days and halved windows, never an offset), refresh, the
 * refresh checkpoint and the congresses it covers, the mirrored-congress read, the
 * store-spec migrations, and, through the real `CongressApiService` over a stubbed
 * `fetch`, the 30 s attempt of a request with no call and the run that resumes an
 * interrupted one from its cursor.
 * @module tests/services/congress-mirror/congress-mirror-service
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({ apiKey: 'test-api-key', baseUrl: 'https://api.congress.gov/v3' }),
}));

import { CongressApiService } from '@/services/congress-api/congress-api-service.js';
import { CongressMirrorService } from '@/services/congress-mirror/congress-mirror-service.js';
import { createCongressBillIngester, type MirrorApi } from '@/services/congress-mirror/ingest.js';
import { billStoreSpec } from '@/services/congress-mirror/schema.js';
import { jsonResponse, track, useFakeClock } from '../../helpers/budget-fixtures.js';
import {
  type FakeBill,
  fakeBills,
  halvedBodyResponse,
  listBillsPage,
  plusSeconds,
} from './fake-bill-list.js';

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

  it('rejects a punctuation-only query as invalid_query, not a SQLite error', async () => {
    await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    const ctx = createMockContext();
    // A raw pass-through of "-" would raise an FTS5 syntax error; the translation drops it and has no term left.
    await expect(service.search({ query: ' - ', limit: 20, offset: 0 }, ctx)).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_query' },
        message: expect.stringMatching(/^The query has no term to search for\./),
      },
    );
  });

  describe('query grammar (#116)', () => {
    /**
     * Words each row carries, for reading the expected sets: W wildfire, S smoke,
     * D drought, X "smoke exposure" as adjacent words.
     */
    const GRAMMAR_ROWS: ReadonlyArray<readonly [title: string, summary: string]> = [
      [
        'Smoke Exposure Crop Insurance Act',
        'Covers crops damaged by wildfire smoke. It does not cover drought or flood losses.',
      ], // 1: W S D X
      ['Wildfire Response Act', 'Funds wildfire suppression or prevention grants.'], // 2: W
      ['Drought Relief Act', 'Aid for farmers hit by drought or extreme heat.'], // 3: D
      ['Wildfire and Drought Resilience Act', 'Grants for wildfire and drought planning.'], // 4: W D
      [
        'Wildfire Smoke Monitoring Act',
        'Monitors smoke exposure from wildfire; does not apply to prescribed burns.',
      ], // 5: W S X
      ['Forest Health Act', 'Thinning to reduce wildfire risk, not a substitute for suppression.'], // 6: W
      [
        'Clean Air Act Amendments',
        'Regulates smoke from industrial sources or vehicles and limits exposure of workers.',
      ], // 7: S
      ['Wildfire Smoke Research Act', 'Studies wildfire smoke and its health effects.'], // 8: W S
      ['Oil and Gas Leasing Act', 'Oil &amp; gas leases on federal lands.'], // 9
      ['Nonprofit Integrity Act', 'Amends section 501(c)(3) of the Internal Revenue Code.'], // 10
      ['Export-Control Reform Act', 'Café owners and semiconductor rules.'], // 11
      ['Solar Energy Act', 'Solar or wind credits.'], // 12
      ['Wind Power Act', 'Solar and wind farms.'], // 13
    ];
    const GRAMMAR_BILLS: FakeBill[] = GRAMMAR_ROWS.map(([title], i) => ({
      congress: 119,
      type: 'hr',
      number: i + 1,
      title,
      originChamber: 'House',
      updatedAt: `2026-02-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
    }));
    const GRAMMAR_SUMMARIES: Row[] = GRAMMAR_ROWS.map(([, summary], i) => ({
      bill: { congress: 119, type: 'hr', number: i + 1 },
      text: `<p>${summary}</p>`,
      updateDate: '2026-03-01T00:00:00Z',
    }));

    /** The bill numbers a query matches, ascending, with the characters it ignored and the exclusions it used. */
    async function matches(
      query: string,
    ): Promise<{ numbers: number[]; unmatched: unknown; exclusions: unknown }> {
      const page = await service.search({ query, limit: 100, offset: 0 }, createMockContext());
      expect(page.items).toHaveLength(page.total);
      return {
        numbers: page.items.map((item) => item.billNumber).sort((a, b) => a - b),
        unmatched: (page as { unmatched?: unknown }).unmatched,
        exclusions: (page as { exclusions?: unknown }).exclusions,
      };
    }

    /** The bill numbers a query matches, ascending. */
    const numbers = async (query: string) => (await matches(query)).numbers;

    beforeEach(async () => {
      api = makeApi(GRAMMAR_BILLS, GRAMMAR_SUMMARIES);
      await service.mirrorInstance.runSync({ mode: 'init', signal: AbortSignal.timeout(60_000) });
    });

    it('holds the expected base sets', async () => {
      expect(await numbers('wildfire')).toEqual([1, 2, 4, 5, 6, 8]);
      expect(await numbers('smoke')).toEqual([1, 5, 7, 8]);
      expect(await numbers('drought')).toEqual([1, 3, 4]);
      expect(await numbers('wildfire smoke')).toEqual([1, 5, 8]);
      expect(await numbers('wildfire drought')).toEqual([1, 4]);
    });

    /** Characterization: inputs whose matches the grammar must leave as they were. */
    it.each([
      { query: 'export-control', expected: [11] },
      { query: '501(c)(3)', expected: [10] },
      { query: 'solar or wind', expected: [12] },
      { query: 'wildfire not smoke', expected: [1, 5] },
      { query: 'wildfire and drought', expected: [4] },
      { query: '"OR" solar', expected: [12] },
      { query: 'cafe', expected: [11] },
      { query: 'café', expected: [11] },
      { query: 'title:wildfire', expected: [] },
      { query: 'NEAR(wildfire smoke)', expected: [] },
    ])('keeps $query matching what it matched before', async ({ query, expected }) => {
      expect(await numbers(query)).toEqual(expected);
    });

    it('unions OR alternatives: wildfire + drought − both', async () => {
      expect(await numbers('wildfire OR drought')).toEqual([1, 2, 3, 4, 5, 6, 8]);
    });

    it.each([
      'wildfire -smoke',
      '-smoke wildfire',
      'wildfire NOT smoke',
      'NOT smoke wildfire',
      'wildfire AND NOT smoke',
    ])('excludes with %o: wildfire − wildfire smoke, none of them smoke rows', async (query) => {
      const found = await numbers(query);
      expect(found).toEqual([2, 4, 6]);
      const smoke = await numbers('smoke');
      expect(found.filter((n) => smoke.includes(n))).toEqual([]);
    });

    it('runs a group after a term, joined with an explicit AND', async () => {
      expect(await numbers('wildfire (drought OR smoke)')).toEqual([1, 4, 5, 8]);
      expect(await numbers('(drought OR smoke) wildfire')).toEqual([1, 4, 5, 8]);
    });

    it('applies an exclusion to its whole group', async () => {
      expect(await numbers('wildfire OR drought -smoke')).toEqual([2, 3, 4, 6]);
      expect(await numbers('wildfire -(smoke OR drought)')).toEqual([2, 6]);
    });

    it('matches a quoted phrase only as adjacent words', async () => {
      expect(await numbers('smoke exposure')).toEqual([1, 5, 7]);
      expect(await numbers('"smoke exposure"')).toEqual([1, 5]);
      expect(await numbers('-"smoke exposure" smoke')).toEqual([7, 8]);
    });

    it('matches word* as a prefix', async () => {
      expect(await numbers('wild*')).toEqual([1, 2, 4, 5, 6, 8]);
      expect(await numbers('wild')).toEqual([]);
    });

    it('drops a token with no letter or digit', async () => {
      expect(await numbers('oil & gas')).toEqual(await numbers('oil gas'));
      expect(await numbers('oil & gas')).toEqual([9]);
      expect(await numbers('wildfire - smoke')).toEqual([1, 5, 8]);
    });

    it.each([
      { query: 'wildfire (smoke', same: 'wildfire smoke', unmatched: ['('] },
      { query: 'wildfire smoke)', same: 'wildfire smoke', unmatched: [')'] },
      { query: '"smoke exposure', same: 'smoke exposure', unmatched: ['"'] },
      { query: '("smoke exposure', same: 'smoke exposure', unmatched: ['(', '"'] },
    ])(
      'ignores the unmatched character in $query and reports it',
      async ({ query, same, unmatched }) => {
        const found = await matches(query);
        expect(found.numbers).toEqual(await numbers(same));
        expect(found.unmatched).toEqual(unmatched);
      },
    );

    it('reports no unmatched character for a balanced query', async () => {
      expect((await matches('wildfire (smoke OR "crop insurance")')).unmatched).toEqual([]);
    });

    it.each([
      { query: 'wildfire NOT smoke', expected: [2, 4, 6], exclusions: ['NOT'] },
      { query: 'wildfire -smoke', expected: [2, 4, 6], exclusions: ['-'] },
      { query: 'wildfire -smoke NOT drought', expected: [2, 6], exclusions: ['-', 'NOT'] },
      { query: 'wildfire NOT (smoke -drought)', expected: [1, 2, 4, 6], exclusions: ['NOT', '-'] },
      { query: 'wildfire not smoke', expected: [1, 5], exclusions: [] },
      { query: 'wildfire OR "smoke exposure" wild*', expected: [1, 2, 4, 5, 6, 8], exclusions: [] },
    ])(
      'pages $query beside the exclusions it used, $exclusions',
      async ({ query, expected, exclusions }) => {
        const found = await matches(query);
        expect(found.numbers).toEqual(expected);
        expect(found.exclusions).toEqual(exclusions);
      },
    );

    it.each([
      { query: '-smoke', token: '-smoke' },
      { query: 'NOT smoke', token: 'NOT smoke' },
      { query: 'OR', token: 'OR' },
      { query: 'wildfire NOT', token: 'NOT' },
      { query: 'wildfire OR', token: 'OR' },
      { query: 'OR wildfire', token: 'OR' },
      { query: 'wildfire OR -smoke', token: 'OR' },
      { query: 'wildfire (-smoke)', token: '-smoke' },
    ])(
      'rejects $query as invalid_query naming $token, before MATCH runs',
      async ({ query, token }) => {
        const match = vi.spyOn(service.mirrorInstance, 'query');
        const rejection = service.search({ query, limit: 20, offset: 0 }, createMockContext());
        await expect(rejection).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_query', retryable: false },
        });
        const error = (await rejection.catch((e: unknown) => e)) as McpError;
        expect(error.message).toContain(token);
        expect(error.data).not.toHaveProperty('field');
        expect(match).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['NUL', '\u0000'],
      ['a C0 control', '\u0001'],
      ['a unit separator', '\u001f'],
      ['DEL', '\u007f'],
      ['a C1 control', '\u0085'],
      ['a lone high surrogate', '\ud800'],
      ['a lone low surrogate', '\udc00'],
      ['a line separator', ' '],
    ])('reads %s between words as a separator', async (_label, separator) => {
      expect(await numbers(`wildfire${separator}smoke`)).toEqual([1, 5, 8]);
      expect(await numbers(`"smoke${separator}exposure"`)).toEqual([1, 5]);
    });

    it('keeps a surrogate pair inside its word', async () => {
      /** U+20000, a letter outside the BMP: one token with the word, so nothing matches. */
      expect(await numbers('wildfire𠀀')).toEqual([]);
      expect(await numbers('wildfire 𠀀 smoke')).toEqual([]);
      expect(await numbers('wildfire 🔥 smoke')).toEqual([1, 5, 8]);
    });

    /** `outcome` of one search: undefined when it resolved or failed `invalid_query`, else what it threw. */
    async function outcome(query: string): Promise<string | undefined> {
      try {
        await service.search({ query, limit: 5, offset: 0 }, createMockContext());
        return undefined;
      } catch (error) {
        const failure = error as McpError;
        if (
          failure.code === JsonRpcErrorCode.ValidationError &&
          failure.data?.reason === 'invalid_query'
        ) {
          return undefined;
        }
        return `${JSON.stringify(query)} → ${failure.name}: ${failure.message}`;
      }
    }

    /** Mulberry32 — a seeded generator, so a failing input reproduces from the seed. */
    function seeded(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      };
    }

    /** Pieces the generated queries are built from: terms, operators, FTS5 syntax, Unicode, and controls. */
    const PIECES = [
      ...'wildfire smoke drought exposure wild or not and AND OR NOT NEAR NEAR( title: summary: {title} : ^ + - -- * ( ) " "" [ ] { } , . & § \' \\ / @ # café 半導体 ß ١٢٣ 501(c)(3) export-control wild* -smoke -( (- COVID-19'.split(
        ' ',
      ),
      ...'"smoke exposure"| |  |\t|\n|\r\n|\u0000|\u0001|\u001f|\u007f|\u0085| |​| |﻿|\ud800|\udfff|🔥|x́|'.split(
        '|',
      ),
    ];

    /** Inputs at the edges: empty, operator-only, quote and parenthesis runs, and long queries. */
    const EDGES = [
      ...'| |NOT|AND|OR|NOT NOT|NOT (|()|(())|-()|-""|""*|*|**|wild**|"wild"*|{title}: wildfire|wildfire:|NEAR("wildfire" "smoke", 2)|wildfire NOT "" smoke|wildfire OR ()|(wildfire) OR (-smoke)|NOT -smoke wildfire|wildfire NOT -(smoke|-(wildfire'.split(
        '|',
      ),
      `${'wildfire OR '.repeat(2_000)}smoke`,
      `${'-x '.repeat(2_000)}wildfire`,
      'a '.repeat(20_000),
      '('.repeat(50_000),
      ')'.repeat(50_000),
      '"'.repeat(50_001),
      '"'.repeat(50_000),
      '-('.repeat(20_000),
      `${'\u0000'.repeat(1_000)}wildfire`,
      `${'('.repeat(10)}wildfire${')'.repeat(10)}`,
      `${'('.repeat(11)}wildfire${')'.repeat(11)}`,
      `${'(a '.repeat(10_000)}wildfire${')'.repeat(10_000)}`,
    ];

    it('translates every input or fails invalid_query, never reaching SQLite as an FTS5 error (#40)', async () => {
      const random = seeded(116);
      const pick = () => PIECES[Math.floor(random() * PIECES.length)] as string;
      const generated = Array.from({ length: 3_000 }, () =>
        Array.from({ length: Math.floor(random() * 24) }, () =>
          random() < 0.1 ? String.fromCharCode(Math.floor(random() * 0x10000)) : pick(),
        ).join(random() < 0.5 ? ' ' : ''),
      );
      const failures: string[] = [];
      for (const query of [...PIECES, ...EDGES, ...generated]) {
        const failure = await outcome(query);
        if (failure) failures.push(failure);
      }
      expect(failures).toEqual([]);
    }, 60_000);

    /** Building blocks of the long chains: terms, phrases, prefixes, exclusions, and small groups. */
    const LINKS = [
      'wildfire',
      'smoke',
      '"smoke exposure"',
      'wild*',
      '-heat',
      'NOT heat',
      '(drought OR smoke)',
      '(wildfire -heat)',
      '-(heat flood)',
      'café',
    ];

    it('translates long chains of every joiner or fails invalid_query, never reaching SQLite as an FTS5 error', async () => {
      const random = seeded(1_160);
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
      const terms = (count: number, term: (i: number) => string) =>
        Array.from({ length: count }, (_, i) => term(i));
      const generated = Array.from({ length: 16 }, () => {
        const fixed = pick([' ', ' AND ', ' OR ']);
        const mixed = random() < 0.5;
        let query = 'wildfire';
        for (let i = 200 + Math.floor(random() * 800); i > 0; i--) {
          query += `${mixed ? pick([' ', ' AND ', ' OR ']) : fixed}${random() < 0.3 ? `w${i}` : pick(LINKS)}`;
        }
        return query;
      });
      /** Each runs past FTS5's expression depth limit (256), so a chain translated as nested operators rather than one flat one would fail. */
      const chains = [
        terms(1_000, (i) => `w${i}`).join(' '),
        `${terms(1_000, (i) => `w${i}`).join(' OR ')} OR wildfire`,
        terms(1_000, (i) => `"a${i} b${i}"`).join(' '),
        terms(1_000, (i) => `p${i}*`).join(' OR '),
        `wildfire ${terms(1_000, (i) => `-x${i}`).join(' ')}`,
        `wildfire ${terms(1_000, (i) => `NOT x${i}`).join(' ')}`,
        terms(500, (i) => `(wildfire -x${i})`).join(' '),
        terms(500, (i) => `(a${i} b${i})`).join(' OR '),
        ...generated,
      ];
      const failures: string[] = [];
      for (const query of chains) {
        const failure = await outcome(query);
        if (failure) failures.push(failure.slice(0, 300));
      }
      expect(failures).toEqual([]);
      expect(await numbers(`${terms(1_000, () => 'wildfire').join(' ')} -smoke`)).toEqual([
        2, 4, 6,
      ]);
    }, 120_000);

    it('answers nesting that leaves the result unchanged at any depth, as the keyword translation did', async () => {
      expect(await numbers(`${'('.repeat(12)}wildfire${')'.repeat(12)}`)).toEqual([
        1, 2, 4, 5, 6, 8,
      ]);
      const twelve =
        'wildfire (smoke (crop (insurance (act (covers (crops (damaged (drought (flood (losses (exposure (cover))))))))))))';
      expect(await numbers(twelve)).toEqual([1]);
      expect(await numbers(twelve)).toEqual(await numbers(twelve.replace(/[()]/g, '')));
      expect(await numbers(`${'('.repeat(5_000)}drought${')'.repeat(5_000)}`)).toEqual([1, 3, 4]);
      expect(await numbers(`wildfire -${'('.repeat(20)}smoke exposure${')'.repeat(20)}`)).toEqual(
        await numbers('wildfire -(smoke exposure)'),
      );
    });

    /** `template` with `C` replaced by the next level, `depth` times, around a group that holds OR. */
    function nest(depth: number, template: string): string {
      let query = 'wildfire OR drought';
      for (let level = 0; level < depth; level++) query = template.replace('C', `(${query})`);
      return query;
    }

    it.each([
      'C OR a',
      'a OR b C',
      'a OR b c C -x',
      'a b OR c C -x',
      'a OR b OR c -x -C',
      'a OR b -C',
      'a -x -y C',
      'a OR ((C))',
      'a OR (b C)',
    ])('runs %o nested 10 counted levels deep and rejects an 11th', async (template) => {
      const deepest = await service.search(
        { query: nest(10, template), limit: 5, offset: 0 },
        createMockContext(),
      );
      expect(deepest.total).toBeGreaterThanOrEqual(0);
      await expect(
        service.search({ query: nest(11, template), limit: 5, offset: 0 }, createMockContext()),
      ).rejects.toMatchObject({
        data: { reason: 'invalid_query' },
        message:
          'The query nests groups that hold OR or an exclusion, or are excluded, more than 10 levels deep. Flatten some of those groups.',
      });
    });
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

  /**
   * The walk through the real `CongressApiService` over a stubbed `fetch`, where
   * one named request answers a 200 whose body stops halfway: until the attempt
   * aborts (a stall), or for 20 s. Congress 119 holds 900 bills, 150 a day over
   * 2025-03-03..08; 118 holds 300, 100 a day over 2024-05-01..03. Runs are driven
   * on a fake clock one second at a time, with a real macrotask between steps for
   * the stream and SQLite work.
   */
  describe('resumable bill walk over the real service (#106)', () => {
    const SUMMARIES_119 = ['summaries/119 offset 0', 'summaries/119 offset 250'];
    const WALK_118 = [
      'summaries/118 offset 0',
      'bill/118 after 2022-12-31T23:59:59Z',
      'bill/118 after 2024-05-02T23:59:59Z',
    ];
    /** An uninterrupted init: 6 + 2 bill pages, 1,200 bills. */
    const INIT_REQUESTS = [
      ...SUMMARIES_119,
      'bill/119 after 2024-12-31T23:59:59Z',
      'bill/119 after 2025-03-03T23:59:59Z',
      'bill/119 after 2025-03-04T23:59:59Z',
      'bill/119 after 2025-03-05T23:59:59Z',
      'bill/119 after 2025-03-06T23:59:59Z',
      'bill/119 after 2025-03-07T23:59:59Z',
      ...WALK_118,
    ];
    const INIT_CHECKPOINT = '2025-03-08|119,118';
    /** An uninterrupted refresh after `moveBills`. */
    const REFRESH_REQUESTS = [
      ...SUMMARIES_119,
      'bill/119 after 2025-03-07T23:59:59Z',
      'bill/119 after 2025-03-31T23:59:59Z',
      'bill/119 after 2025-04-01T23:59:59Z',
      'bill/119 after 2025-04-02T23:59:59Z',
      'bill/119 after 2025-04-03T23:59:59Z',
      'summaries/118 offset 0',
      'bill/118 after 2025-03-07T23:59:59Z',
    ];

    /** The upstream's data, read on every request, so a test can edit it between runs. */
    let bills: FakeBill[];
    let summaries: Row[];
    /** The current run's requests, in order. */
    let requests: string[];
    /** The request answered with a half body: stalled until abort, or paused `pauseMs`. */
    let slow: { pauseMs?: number; request: string } | undefined;

    /** `count` bills from `firstNumber`, `perDay` a day from `firstDay`, one a minute from 00:00:00Z. */
    const daily = (
      congress: number,
      count: number,
      firstNumber: number,
      perDay: number,
      firstDay: string,
    ): FakeBill[] =>
      fakeBills(congress, count, firstNumber, (i) =>
        plusSeconds(`${firstDay}T00:00:00Z`, Math.floor(i / perDay) * 86_400 + (i % perDay) * 60),
      );

    /** A CRS summary for every `every`-th bill of `list`. */
    const summariesOf = (list: FakeBill[], every: number): Row[] =>
      list
        .filter((_, i) => i % every === 0)
        .map((bill) => ({
          bill: { congress: bill.congress, type: bill.type, number: bill.number },
          text: `<p>Summary of bill ${bill.number}.</p>`,
          updateDate: '2025-03-10T00:00:00Z',
        }));

    /** `next` while rows remain past this page, as Congress.gov's pagination carries it. */
    const pagination = (url: URL, count: number, offset: number, limit: number) => ({
      count,
      ...(offset + limit < count
        ? { next: `${url.origin}${url.pathname}?offset=${offset + limit}` }
        : {}),
    });

    /**
     * api.congress.gov over `bills` and `summaries`, recording each request as
     * `bill/119 after <from>[ before <to>]` or `summaries/119 offset <n>`. The
     * summaries list holds every summary updated since `fromDateTime`, newest first.
     */
    function upstream(url: string | URL, init?: RequestInit): Promise<Response> {
      const parsed = new URL(String(url));
      const query = parsed.searchParams;
      const [, , resource, segment] = parsed.pathname.split('/');
      const congress = Number(segment);
      const offset = Number(query.get('offset') ?? 0);
      const limit = Number(query.get('limit') ?? 20);
      let request: string;
      let body: Record<string, unknown>;
      if (resource === 'bill') {
        const from = query.get('fromDateTime') ?? undefined;
        const to = query.get('toDateTime') ?? undefined;
        request = `bill/${congress} after ${from}${to ? ` before ${to}` : ''}${offset ? ` offset ${offset}` : ''}`;
        const page = listBillsPage(bills, {
          congress,
          sort: query.get('sort') ?? undefined,
          limit,
          offset,
          fromDateTime: from,
          toDateTime: to,
        });
        body = {
          bills: page.data,
          pagination: pagination(parsed, page.pagination.count, offset, limit),
        };
      } else if (resource === 'summaries') {
        request = `summaries/${congress} offset ${offset}`;
        const from = query.get('fromDateTime');
        const rows = from
          ? summaries
              .filter((s) => (s.bill as Row).congress === congress && String(s.updateDate) >= from)
              .sort((a, b) => String(b.updateDate).localeCompare(String(a.updateDate)))
          : [];
        body = {
          summaries: rows.slice(offset, offset + limit),
          pagination: pagination(parsed, rows.length, offset, limit),
        };
      } else {
        return Promise.reject(new Error(`unexpected request ${parsed.pathname}`));
      }
      requests.push(request);
      return Promise.resolve(
        slow?.request === request
          ? halvedBodyResponse(JSON.stringify(body), init?.signal, slow.pauseMs)
          : jsonResponse(body),
      );
    }

    /** Reopen the store over `congresses` through a real `CongressApiService`, opened on the real clock. */
    async function openReal(congresses: number[]): Promise<void> {
      vi.useRealTimers();
      await service.mirrorInstance.close();
      const congressApi = new CongressApiService();
      service = new CongressMirrorService({
        mirrorPath: dbPath,
        congresses,
        getApi: () => congressApi,
      });
      await service.mirrorInstance.status();
      useFakeClock();
    }

    /** Run one sync to its end, a fake second at a time, with the requests it made. */
    async function runToEnd(mode: 'init' | 'refresh') {
      requests = [];
      const startedAt = Date.now();
      const run = track(
        service.mirrorInstance.runSync({ mode, signal: new AbortController().signal }),
      );
      for (let step = 0; run.state.settledAt === undefined && step < 600; step++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(run.state.settledAt, `the ${mode} settled`).toBeDefined();
      return {
        ...run.state,
        elapsedMs: (run.state.settledAt as number) - startedAt,
        requests,
      };
    }

    /** The run failure a stalled request ends in: three 30 s attempts. */
    function expectStalled(error: unknown): void {
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'upstream_timeout', retryAttempts: 3 },
      });
      expect((error as McpError).message).toBe(
        'Congress.gov did not complete the request within the 30000-millisecond deadline. (failed after 3 attempts)',
      );
    }

    /** Every stored bill id, sorted, and how many rows carry a summary. */
    async function stored(): Promise<{ ids: string[]; summarized: number }> {
      const db = await service.mirrorInstance.raw();
      const rows = db
        .prepare<{ billId: string; summary: string | null }>('SELECT billId, summary FROM bills')
        .all();
      return {
        ids: rows.map((row) => row.billId).sort(),
        summarized: rows.filter((row) => row.summary !== null).length,
      };
    }

    const idsOf = (list: FakeBill[]) =>
      list.map((bill) => `${bill.congress}/${bill.type}/${bill.number}`).sort();

    /** After an init: 119's bills 10000–10599 move to 2025-04-01..04 (150 a day), 118's 20000–20049 to 2025-04-02. */
    function moveBills(): FakeBill[] {
      const moved: FakeBill[] = [];
      for (const bill of bills) {
        const n = Number(bill.number);
        if (bill.congress === 119 && n < 10_600) {
          const i = n - 10_000;
          bill.updatedAt = plusSeconds(
            '2025-04-01T00:00:00Z',
            Math.floor(i / 150) * 86_400 + (i % 150) * 60,
          );
        } else if (bill.congress === 118 && n < 20_050) {
          bill.updatedAt = plusSeconds('2025-04-02T06:00:00Z', (n - 20_000) * 60);
        } else {
          continue;
        }
        bill.title = `Moved ${n}`;
        moved.push(bill);
      }
      return moved;
    }

    beforeEach(async () => {
      const congress119 = daily(119, 900, 10_000, 150, '2025-03-03');
      const congress118 = daily(118, 300, 20_000, 100, '2024-05-01');
      bills = [...congress119, ...congress118];
      summaries = [...summariesOf(congress119, 3), ...summariesOf(congress118, 10)];
      requests = [];
      slow = undefined;
      vi.stubGlobal('fetch', upstream);
      await openReal([119, 118]);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it.each([
      { stalled: 'bill/119 after 2024-12-31T23:59:59Z', committed: 0, resumed: INIT_REQUESTS },
      {
        stalled: 'bill/119 after 2025-03-05T23:59:59Z',
        committed: 300,
        resumed: [
          ...SUMMARIES_119,
          'bill/119 after 2025-03-04T23:59:59Z',
          'bill/119 after 2025-03-05T23:59:59Z',
          'bill/119 after 2025-03-06T23:59:59Z',
          'bill/119 after 2025-03-07T23:59:59Z',
          ...WALK_118,
        ],
      },
      {
        stalled: 'summaries/118 offset 0',
        committed: 750,
        resumed: [...SUMMARIES_119, 'bill/119 after 2025-03-07T23:59:59Z', ...WALK_118],
      },
      {
        stalled: 'bill/118 after 2022-12-31T23:59:59Z',
        committed: 750,
        resumed: [...SUMMARIES_119, 'bill/119 after 2025-03-07T23:59:59Z', ...WALK_118],
      },
      { stalled: 'bill/118 after 2024-05-02T23:59:59Z', committed: 900, resumed: WALK_118 },
    ])(
      'resumes an init stalled at $stalled without re-requesting a committed page',
      async ({ stalled, committed, resumed }) => {
        slow = { request: stalled };
        const failed = await runToEnd('init');
        expectStalled(failed.error);
        expect(failed.requests).toEqual([
          ...INIT_REQUESTS.slice(0, INIT_REQUESTS.indexOf(stalled)),
          stalled,
          stalled,
          stalled,
        ]);
        expect((await stored()).ids).toHaveLength(committed);
        const afterFailure = await service.mirrorInstance.status();
        expect(afterFailure).toMatchObject({ status: 'error', ready: false });
        expect(afterFailure.checkpoint).toBeUndefined();

        slow = undefined;
        const run = await runToEnd('init');
        expect(run.error).toBeUndefined();
        expect(run.requests).toEqual(resumed);
        expect(run.value?.recordsApplied).toBe(1200 - committed);
        expect(await service.mirrorInstance.status()).toMatchObject({
          status: 'complete',
          ready: true,
          checkpoint: INIT_CHECKPOINT,
          total: 1200,
        });
        expect(await stored()).toEqual({ ids: idsOf(bills), summarized: 330 });
      },
    );

    it('keeps the stored checkpoint when a refresh stalls partway, and its resume re-requests no committed page', async () => {
      expect((await runToEnd('init')).requests).toEqual(INIT_REQUESTS);
      const moved = moveBills();
      const stalled = 'bill/119 after 2025-04-02T23:59:59Z';
      slow = { request: stalled };
      const failed = await runToEnd('refresh');
      expectStalled(failed.error);
      expect(failed.requests).toEqual([
        ...REFRESH_REQUESTS.slice(0, REFRESH_REQUESTS.indexOf(stalled)),
        stalled,
        stalled,
        stalled,
      ]);
      expect(await service.mirrorInstance.status()).toMatchObject({
        status: 'error',
        ready: true,
        checkpoint: INIT_CHECKPOINT,
      });

      slow = undefined;
      const run = await runToEnd('refresh');
      expect(run.error).toBeUndefined();
      /** The 03-08 and 04-01 pages were committed before the stall; the 04-02 page was held. */
      expect(run.requests).toEqual([
        ...SUMMARIES_119,
        'bill/119 after 2025-04-01T23:59:59Z',
        'bill/119 after 2025-04-02T23:59:59Z',
        'bill/119 after 2025-04-03T23:59:59Z',
        'summaries/118 offset 0',
        'bill/118 after 2025-03-07T23:59:59Z',
      ]);
      /** 119's 04-02, 04-03, and 04-04 bills and 118's 50 moved ones. */
      expect(run.value?.recordsApplied).toBe(500);
      expect(await service.mirrorInstance.status()).toMatchObject({
        status: 'complete',
        checkpoint: '2025-04-04|119,118',
        total: 1200,
      });
      const titles = await service.mirrorInstance.getByIds(idsOf(moved));
      expect(titles.filter((row) => !String(row.title).startsWith('Moved '))).toEqual([]);
      expect(titles).toHaveLength(650);
    });

    it.each([
      { mode: 'init' as const, paused: 'bill/119 after 2025-03-04T23:59:59Z' },
      { mode: 'refresh' as const, paused: 'bill/119 after 2025-04-01T23:59:59Z' },
    ])(
      'completes the $mode in one run when a page pauses 20 s mid-body',
      async ({ mode, paused }) => {
        if (mode === 'refresh') {
          await runToEnd('init');
          moveBills();
        }
        slow = { request: paused, pauseMs: 20_000 };
        const run = await runToEnd(mode);

        expect(run.error).toBeUndefined();
        expect(run.requests).toEqual(mode === 'init' ? INIT_REQUESTS : REFRESH_REQUESTS);
        expect(run.elapsedMs).toBeGreaterThanOrEqual(20_000);
        expect((await service.mirrorInstance.status()).checkpoint).toBe(
          mode === 'init' ? INIT_CHECKPOINT : '2025-04-04|119,118',
        );
      },
    );

    it.each([
      { form: 'not JSON', cursor: 'not json' },
      {
        form: 'another version',
        cursor: JSON.stringify({
          v: 2,
          startedOn: '2025-03-09',
          through: '2025-03-08',
          done: [119],
          walking: { congress: 118, day: '2024-05-03' },
        }),
      },
    ])('walks an init from the start when the stored cursor is $form', async ({ cursor }) => {
      await service.mirrorInstance.store.writeState({ status: 'error', mode: 'init', cursor });
      const run = await runToEnd('init');

      expect(run.error).toBeUndefined();
      expect(run.requests).toEqual(INIT_REQUESTS);
      expect(run.value?.recordsApplied).toBe(1200);
      expect((await service.mirrorInstance.status()).checkpoint).toBe(INIT_CHECKPOINT);
    });

    it('walks only the configured congresses when the cursor names one no longer configured', async () => {
      slow = { request: 'bill/119 after 2025-03-05T23:59:59Z' };
      expectStalled((await runToEnd('init')).error);

      slow = undefined;
      await openReal([118]);
      const run = await runToEnd('init');
      expect(run.error).toBeUndefined();
      expect(run.requests).toEqual(WALK_118);
      expect(run.value?.recordsApplied).toBe(300);
      /** The highest list date the cursor carried, from the 119 pages committed before the stall. */
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2025-03-04|118');
    });

    it('caps the checkpoint date at the day the interrupted run began, so the next refresh re-reads a congress the resume skipped', async () => {
      vi.setSystemTime(new Date('2025-03-09T12:00:00Z'));
      slow = { request: 'bill/118 after 2024-05-02T23:59:59Z' };
      expectStalled((await runToEnd('init')).error);

      /** After the run began, a 119 bill (walked already) updates on 03-10 and a 118 bill (still to walk) on 03-11. */
      const hr10000 = bills.find((bill) => bill.number === 10_000) as FakeBill;
      hr10000.updatedAt = '2025-03-10T08:00:00Z';
      hr10000.title = 'Bumped 10000';
      (bills.find((bill) => bill.number === 20_000) as FakeBill).updatedAt = '2025-03-11T09:00:00Z';
      vi.setSystemTime(new Date('2025-03-11T12:00:00Z'));
      slow = undefined;
      const resumed = await runToEnd('init');
      expect(resumed.requests).toEqual(WALK_118);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2025-03-09|119,118');

      const refresh = await runToEnd('refresh');
      expect(refresh.requests).toEqual([
        ...SUMMARIES_119,
        'bill/119 after 2025-03-08T23:59:59Z',
        'summaries/118 offset 0',
        'bill/118 after 2025-03-08T23:59:59Z',
      ]);
      expect((await service.mirrorInstance.getByIds(['119/hr/10000']))[0]?.title).toBe(
        'Bumped 10000',
      );
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2025-03-11|119,118');
    });

    it('reads a day walked in halved windows again when the run resumes inside it', async () => {
      bills = [
        ...fakeBills(119, 150, 30_000, (i) => plusSeconds('2025-03-03T00:00:00Z', i * 60)),
        ...fakeBills(119, 150, 30_150, (i) => plusSeconds('2025-03-03T12:00:00Z', i * 60)),
        ...fakeBills(119, 100, 30_300, (i) => plusSeconds('2025-03-04T00:00:00Z', i * 60)),
      ];
      summaries = summariesOf(bills, 3);
      await openReal([119]);
      const day = [
        'bill/119 after 2025-03-02T23:59:59Z before 2025-03-04T00:00:00Z',
        'bill/119 after 2025-03-02T23:59:59Z before 2025-03-03T12:00:00Z',
        'bill/119 after 2025-03-03T11:59:59Z before 2025-03-04T00:00:00Z',
      ];
      const stalled = 'bill/119 after 2025-03-03T23:59:59Z';
      slow = { request: stalled };
      const failed = await runToEnd('init');
      expectStalled(failed.error);
      expect(failed.requests).toEqual([
        'summaries/119 offset 0',
        'bill/119 after 2024-12-31T23:59:59Z',
        ...day,
        stalled,
        stalled,
        stalled,
      ]);
      /** The morning window was committed; the afternoon one was held for the next page. */
      expect((await stored()).ids).toHaveLength(150);

      slow = undefined;
      const run = await runToEnd('init');
      expect(run.error).toBeUndefined();
      /** The cursor holds the day, not a window inside it: the whole day is read again. */
      expect(run.requests).toEqual([
        'summaries/119 offset 0',
        'bill/119 after 2025-03-02T23:59:59Z',
        ...day,
        stalled,
      ]);
      expect(run.value?.recordsApplied).toBe(400);
      expect((await service.mirrorInstance.status()).checkpoint).toBe('2025-03-04|119');
      expect(await stored()).toEqual({ ids: idsOf(bills), summarized: 134 });
    });
  });
});

/**
 * @fileoverview Tests for congressgov_search_bills — the readiness-gated empty
 * path (mirror never built → empty result + notice, no throw) and the keyword
 * match path (populated mirror → ranked hit with title + summary preview). The
 * mirror is driven by a mocked Congress API so the tool exercises the real query
 * pipeline without live traffic.
 * @module tests/mcp-server/tools/definitions/search-bills.tool
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchBillsTool } from '@/mcp-server/tools/definitions/search-bills.tool.js';
import {
  getCongressMirror,
  initCongressMirror,
  resetCongressMirror,
} from '@/services/congress-mirror/congress-mirror-service.js';
import type { MirrorApi } from '@/services/congress-mirror/ingest.js';

const BILLS: Record<string, unknown>[] = [
  {
    congress: 119,
    type: 'hr',
    number: 1,
    title: 'Semiconductor Export Control Act',
    originChamber: 'House',
    latestAction: { actionDate: '2026-01-05', text: 'Referred to committee' },
    updateDate: '2026-01-10',
  },
];

const SUMMARIES: Record<string, unknown>[] = [
  {
    bill: { congress: 119, type: 'hr', number: 1 },
    text: '<p>Restricts the export of advanced semiconductor manufacturing equipment.</p>',
    updateDate: '2026-01-08',
  },
];

function makeApi(): MirrorApi {
  return {
    async listBills(params) {
      const rows = BILLS.filter((b) => b.congress === params.congress);
      return (params.offset ?? 0) > 0
        ? { data: [], pagination: { count: rows.length, nextOffset: null } }
        : { data: rows, pagination: { count: rows.length, nextOffset: null } };
    },
    async listSummaries(params) {
      return (params.offset ?? 0) > 0
        ? { data: [], pagination: { count: SUMMARIES.length, nextOffset: null } }
        : { data: SUMMARIES, pagination: { count: SUMMARIES.length, nextOffset: null } };
    },
  };
}

describe('congressgov_search_bills', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `congress-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`,
    );
    initCongressMirror({ mirrorPath: dbPath, congresses: [119], getApi: makeApi });
  });

  afterEach(async () => {
    await getCongressMirror().mirrorInstance.close();
    resetCongressMirror();
    for (const suffix of ['', '-wal', '-shm']) {
      const path = dbPath + suffix;
      if (existsSync(path)) rmSync(path, { force: true });
    }
  });

  it('returns an empty result with a notice when the mirror is not ready', async () => {
    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'semiconductor' });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(result.pagination.count).toBe(0);
    expect(result.pagination.nextOffset).toBeNull();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(String(enrichment.notice)).toMatch(/mirror|build/i);
  });

  it.each(['   ', '""', '---', '...', '§', '()'])(
    'rejects tokenless query %o at the input boundary before checking readiness',
    (query) => {
      const ready = vi.spyOn(getCongressMirror(), 'ready');
      const result = searchBillsTool.input.safeParse({ query });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['query']);
      expect(ready).not.toHaveBeenCalled();
    },
  );

  it.each(['COVID-19', '501(c)(3)', 'e-mail', '§1983', 'café', '半導体'])(
    'accepts punctuation-bearing or Unicode query %o',
    (query) => {
      expect(searchBillsTool.input.safeParse({ query }).success).toBe(true);
    },
  );

  it('returns a ranked keyword hit once the mirror is built', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'semiconductor' });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.pagination.count).toBe(1);
    expect(result.data).toHaveLength(1);
    const hit = result.data[0] as Record<string, unknown>;
    expect(hit.billId).toBe('119/hr/1');
    expect(hit.title).toBe('Semiconductor Export Control Act');
    expect(String(hit.summaryPreview)).toContain('semiconductor');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(String(enrichment.effectiveQuery)).toContain('semiconductor');
  });

  it('leaves notice unset when the offset runs past the matched set (#49)', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'semiconductor', offset: 5 });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(result.pagination.count).toBe(1);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    // Matches exist — this page is past the end, not a failed keyword search.
    expect(enrichment.notice).toBeUndefined();

    const text = (searchBillsTool.format!(result)[0] as { text: string }).text;
    expect(text).toMatch(/past the end of 1 total item/);
  });

  it('keeps the keyword no-match notice when nothing matched at all', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'zzznomatchzzz' });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.pagination.count).toBe(0);
    expect(getEnrichment(ctx).notice).toMatch(/No bills matched "zzznomatchzzz"/);
  });

  it('renders the hit into content[] via format()', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });
    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'semiconductor' });
    const result = await searchBillsTool.handler(input, ctx);

    const blocks = searchBillsTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Semiconductor Export Control Act');
    expect(text).toContain('119/hr/1');
  });

  it('keeps the keyword no-match notice for a congress the mirror holds', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    const ctx = createMockContext({ errors: searchBillsTool.errors });
    const input = searchBillsTool.input.parse({ query: 'zzznomatchzzz', congress: 119 });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.pagination.count).toBe(0);
    expect(getEnrichment(ctx).notice).toBe(
      'No bills matched "zzznomatchzzz". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.',
    );
  });

  describe('mirroredCongresses (#99)', () => {
    /** The text of every `content[]` block, joined. */
    const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

    it('answers a congress outside the mirrored window with an empty result and a notice naming the window', async () => {
      await getCongressMirror().mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });

      const result = await runToolContract(searchBillsTool, {
        query: 'semiconductor',
        congress: 117,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        data: [],
        pagination: { count: 0, nextOffset: null },
        totalCount: 0,
        mirroredCongresses: [119],
      });
      const notice = String(structured.notice);
      expect(notice).toBe(
        "The bill search mirror holds the 119th Congress only, so it can't search the 117th Congress. Browse that congress's bills with congressgov_bill_lookup (operation 'list', congress 117), which reads Congress.gov live but has no keyword search.",
      );
      expect(notice).not.toMatch(/No bills matched/);

      const text = contentText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain('**Mirrored congresses:** 119');
    });

    it('names every mirrored congress when a configured congress has no stored rows', async () => {
      await getCongressMirror().mirrorInstance.close();
      resetCongressMirror();
      initCongressMirror({ mirrorPath: dbPath, congresses: [118, 119], getApi: makeApi });
      await getCongressMirror().mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });

      const ctx = createMockContext({ errors: searchBillsTool.errors });
      const input = searchBillsTool.input.parse({ query: 'semiconductor', congress: 118 });
      const result = await searchBillsTool.handler(input, ctx);

      expect(result).toEqual({ data: [], pagination: { count: 0, nextOffset: null } });
      const enrichment = getEnrichment(ctx);
      expect(enrichment.mirroredCongresses).toEqual([119]);
      expect(String(enrichment.notice)).toMatch(
        /^The bill search mirror holds the 119th Congress only, so it can't search the 118th Congress\./,
      );
    });

    it.each([
      { stored: [], held: 'no bills' },
      { stored: [118, 119], held: 'the 118th and 119th Congresses only' },
      { stored: [116, 118, 119], held: 'the 116th, 118th, and 119th Congresses only' },
    ])(
      'names a window of $stored.length stored congresses in the out-of-window notice',
      async ({ stored, held }) => {
        await getCongressMirror().mirrorInstance.close();
        resetCongressMirror();
        const rows = stored.map((congress, i) => ({ ...BILLS[0], congress, number: 10 + i }));
        initCongressMirror({
          mirrorPath: dbPath,
          congresses: stored.length > 0 ? stored : [119],
          getApi: () => ({
            ...makeApi(),
            async listBills(params) {
              const data = rows.filter((row) => row.congress === params.congress);
              return { data, pagination: { count: data.length, nextOffset: null } };
            },
          }),
        });
        await getCongressMirror().mirrorInstance.runSync({
          mode: 'init',
          signal: AbortSignal.timeout(60_000),
        });

        const ctx = createMockContext({ errors: searchBillsTool.errors });
        const input = searchBillsTool.input.parse({ query: 'semiconductor', congress: 117 });
        await searchBillsTool.handler(input, ctx);

        const enrichment = getEnrichment(ctx);
        expect(enrichment.mirroredCongresses).toEqual(stored);
        expect(String(enrichment.notice)).toMatch(
          new RegExp(
            `^The bill search mirror holds ${held}, so it can't search the 117th Congress\\.`,
          ),
        );
      },
    );

    it('adds the field to an in-window hit and leaves its results and notices as they were', async () => {
      await getCongressMirror().mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });

      const result = await runToolContract(searchBillsTool, {
        query: 'semiconductor',
        congress: 119,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        pagination: { count: 1, nextOffset: null },
        totalCount: 1,
        mirroredCongresses: [119],
      });
      expect(structured.notice).toBeUndefined();
      expect((structured.data as Record<string, unknown>[])[0]?.billId).toBe('119/hr/1');
      const text = contentText(result);
      expect(text).toContain('119/hr/1');
      expect(text).toContain('**Mirrored congresses:** 119');
    });

    it('reports an empty window while the mirror is not ready, keeping the build notice', async () => {
      const result = await runToolContract(searchBillsTool, {
        query: 'semiconductor',
        congress: 117,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ totalCount: 0, mirroredCongresses: [] });
      expect(String(structured.notice)).toMatch(/has not finished its initial build/);
      expect(contentText(result)).toContain('**Mirrored congresses:** none');
    });
  });

  /** The grammar itself is tabled at `toFtsMatch` and the service; these prove the tool's wiring. */
  describe('query grammar (#116)', () => {
    const contentText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

    beforeEach(async () => {
      await getCongressMirror().mirrorInstance.runSync({
        mode: 'init',
        signal: AbortSignal.timeout(60_000),
      });
    });

    it('searches the translated query, so OR takes either alternative', async () => {
      const result = await runToolContract(searchBillsTool, {
        query: 'zzznomatch OR semiconductor',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ pagination: { count: 1 }, totalCount: 1 });
      expect(structured.notice).toBeUndefined();
      expect(contentText(result)).toContain('119/hr/1');
    });

    it('fails invalid_query on both surfaces, with the declared recovery', async () => {
      const declared = searchBillsTool.errors?.find((entry) => entry.reason === 'invalid_query');
      const result = await runToolContract(searchBillsTool, { query: '-semiconductor' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message:
            'The query has no term to search for: -semiconductor only excludes. Add a term to search for beside it, as in wildfire -semiconductor.',
          data: {
            reason: 'invalid_query',
            retryable: false,
            recovery: { hint: declared?.recovery },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain(
        'Error: The query has no term to search for: `-semiconductor` only excludes.',
      );
      expect(text).toContain(`Recovery: ${declared?.recovery}`);
      expect(text).toContain('(reason invalid_query · not retryable)');
    });

    it('names an ignored unmatched mark in the notice on both surfaces', async () => {
      const result = await runToolContract(searchBillsTool, { query: 'semiconductor (export' });
      const structured = result.structuredContent as Record<string, unknown>;
      const notice = "The query's unmatched ( was ignored; pair ( with ) to group terms.";
      expect(structured).toMatchObject({ pagination: { count: 1 }, notice });
      expect(contentText(result)).toContain(`> ${notice}`);
    });

    it('adds the no-match notice after the unmatched one', async () => {
      const ctx = createMockContext({ errors: searchBillsTool.errors });
      const input = searchBillsTool.input.parse({ query: '("zzznomatch' });
      await searchBillsTool.handler(input, ctx);
      expect(getEnrichment(ctx).notice).toBe(
        'The query\'s unmatched ( and " were ignored; pair ( with ) to group terms, and put " on both sides of an exact phrase. No bills matched "("zzznomatch". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.',
      );
    });

    const NOT_READ =
      'The query\'s NOT was read as an exclusion; to search for the word NOT, quote it ("NOT").';
    const HYPHEN_READ =
      "The query's - at the start of a word was read as an exclusion; to search for a hyphenated term, join the hyphen to the word before it (covid-19).";

    /** The search's notice on both surfaces: `structuredContent.notice`, and the same text quoted in `content[]`. */
    async function searchNotice(query: string) {
      const result = await runToolContract(searchBillsTool, { query });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      const notice = structured.notice as string | undefined;
      if (notice !== undefined) expect(contentText(result)).toContain(`> ${notice}`);
      return { count: (structured.pagination as { count: number }).count, notice, result };
    }

    it('says how an uppercase NOT was read, on a search that found rows', async () => {
      const { count, notice } = await searchNotice('EXPORT NOT CALL');
      expect(count).toBe(1);
      expect(notice).toBe(NOT_READ);
    });

    it('says how a - at the start of a word was read, on a search that found rows', async () => {
      const { count, notice } = await searchNotice('semiconductor -19');
      expect(count).toBe(1);
      expect(notice).toBe(HYPHEN_READ);
    });

    it('names both exclusions in one notice, in the order the query used them', async () => {
      const { count, notice } = await searchNotice('semiconductor -19 NOT wetlands');
      expect(count).toBe(1);
      expect(notice).toBe(
        'The query\'s - at the start of a word and NOT were read as exclusions; to search for a hyphenated term, join the hyphen to the word before it (covid-19), and to search for the word NOT, quote it ("NOT").',
      );
    });

    it('adds the exclusion notice after the unmatched one and before the no-match one', async () => {
      const { count, notice, result } = await searchNotice('(export NOT semiconductor');
      expect(count).toBe(0);
      const unmatched = "The query's unmatched ( was ignored; pair ( with ) to group terms.";
      const noMatch =
        'No bills matched "(export NOT semiconductor". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.';
      expect(notice).toBe(`${unmatched} ${NOT_READ} ${noMatch}`);
      const text = contentText(result);
      expect(text.indexOf(unmatched)).toBeLessThan(text.indexOf(NOT_READ));
      expect(text.indexOf(NOT_READ)).toBeLessThan(text.indexOf(noMatch));
    });

    it('adds no notice for OR, a phrase, a prefix, or a group', async () => {
      const { count, notice, result } = await searchNotice(
        '"export control" OR (semicond* equipment)',
      );
      expect(count).toBe(1);
      expect(notice).toBeUndefined();
      expect(contentText(result)).not.toContain('exclusion');
    });

    it('searches a lowercase not as a word, with no exclusion notice', async () => {
      const { count, notice } = await searchNotice('semiconductor not wetlands');
      expect(count).toBe(0);
      expect(notice).toBe(
        'No bills matched "semiconductor not wetlands". Try broader or fewer keywords, or remove the congress/billType/originChamber filters.',
      );
    });
  });

  /** A query the grammar can't translate is the caller's to fix: its failure record logs below error (#116). */
  it('declares invalid_query as a non-retryable ValidationError at notice severity', () => {
    expect(searchBillsTool.errors?.filter((entry) => entry.reason === 'invalid_query')).toEqual([
      expect.objectContaining({
        code: JsonRpcErrorCode.ValidationError,
        reason: 'invalid_query',
        retryable: false,
        severity: 'notice',
      }),
    ]);
  });

  /** Every accepted filter is declared, so a stray key is a typo to name, not to strip. */
  it('rejects an undeclared argument key by name', () => {
    const result = searchBillsTool.input.safeParse({ query: 'semiconductor', billTpye: 'hr' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['billTpye'],
    });
  });
});

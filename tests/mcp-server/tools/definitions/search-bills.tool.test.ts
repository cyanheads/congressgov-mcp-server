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
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      return (params.offset ?? 0) > 0
        ? { data: [], pagination: { count: BILLS.length, nextOffset: null } }
        : { data: BILLS, pagination: { count: BILLS.length, nextOffset: null } };
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
    const ctx = createMockContext();
    const input = searchBillsTool.input.parse({ query: 'semiconductor' });
    const result = await searchBillsTool.handler(input, ctx);

    expect(result.data).toHaveLength(0);
    expect(result.pagination.count).toBe(0);
    expect(result.pagination.nextOffset).toBeNull();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(String(enrichment.notice)).toMatch(/mirror|build/i);
  });

  it('returns a ranked keyword hit once the mirror is built', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });

    const ctx = createMockContext();
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

  it('renders the hit into content[] via format()', async () => {
    await getCongressMirror().mirrorInstance.runSync({
      mode: 'init',
      signal: AbortSignal.timeout(60_000),
    });
    const ctx = createMockContext();
    const input = searchBillsTool.input.parse({ query: 'semiconductor' });
    const result = await searchBillsTool.handler(input, ctx);

    const blocks = searchBillsTool.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Semiconductor Export Control Act');
    expect(text).toContain('119/hr/1');
  });
});

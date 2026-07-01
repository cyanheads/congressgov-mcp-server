/**
 * @fileoverview Congress bill mirror service — the read path over the local
 * SQLite FTS index of Congress.gov bills. Built on the framework MirrorService:
 * owns the store + ingester, exposes the mirror instance to the lifecycle CLI and
 * the refresh scheduler, and translates the search tool's query grammar into an
 * FTS5 `MATCH` + indexed filters. There is no live-API fallback — keyword search
 * is the entire point — so a cold mirror is a readiness signal the caller turns
 * into an empty result + notice, never a throw.
 * @module services/congress-mirror/congress-mirror-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  defineMirror,
  type Mirror,
  type MirrorRow,
  type QueryFilter,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { createCongressBillIngester, type MirrorApi } from './ingest.js';
import { toFtsMatch } from './normalize.js';
import { billStoreSpec } from './schema.js';
import type { SearchBillResult, SearchBillsFilters, SearchBillsPage } from './types.js';

/** Max stored-summary characters surfaced as a search-result preview. */
const SUMMARY_PREVIEW_LIMIT = 400;

/** Options for constructing the mirror service. */
export interface CongressMirrorOptions {
  /** Congress numbers to mirror. */
  congresses: number[];
  /** API accessor override — defaults to the shared `CongressApiService` singleton. */
  getApi?: () => MirrorApi;
  /** Filesystem path to the SQLite mirror index. */
  mirrorPath: string;
}

/** Project a raw mirror row into a search result, truncating the summary preview. */
function toSearchResult(row: MirrorRow): SearchBillResult {
  const summary =
    typeof row.summary === 'string' && row.summary.trim() !== '' ? row.summary : undefined;
  const summaryPreview = summary
    ? summary.length > SUMMARY_PREVIEW_LIMIT
      ? `${summary.slice(0, SUMMARY_PREVIEW_LIMIT - 1).trimEnd()}…`
      : summary
    : undefined;
  return {
    billId: String(row.billId),
    congress: Number(row.congress),
    billType: String(row.billType),
    billNumber: Number(row.billNumber),
    title: typeof row.title === 'string' ? row.title : '',
    ...(row.originChamber ? { originChamber: String(row.originChamber) } : {}),
    ...(row.latestActionDate ? { latestActionDate: String(row.latestActionDate) } : {}),
    ...(row.latestActionText ? { latestActionText: String(row.latestActionText) } : {}),
    ...(summaryPreview ? { summaryPreview } : {}),
  };
}

export class CongressMirrorService {
  private readonly mirror: Mirror;

  constructor(options: CongressMirrorOptions) {
    const store = sqliteMirrorStore(billStoreSpec(options.mirrorPath));
    this.mirror = defineMirror({
      name: 'congress-bills',
      store,
      sync: createCongressBillIngester(
        options.getApi ?? (() => getCongressApi()),
        options.congresses,
      ),
    });
  }

  /** The underlying mirror — exposed for the lifecycle CLI and the refresh scheduler. */
  get mirrorInstance(): Mirror {
    return this.mirror;
  }

  /** `true` once a full sync has ever completed (queryable even mid-refresh). */
  ready(): Promise<boolean> {
    return this.mirror.ready();
  }

  /**
   * Keyword-search the mirror. The query is tokenized and each token individually
   * quoted before the FTS5 `MATCH` is built; an input with no searchable tokens
   * yields an empty page rather than a thrown query. Optional exact-match filters
   * ride the indexed columns; results are BM25-ranked.
   */
  async search(filters: SearchBillsFilters, ctx: Context): Promise<SearchBillsPage> {
    const match = toFtsMatch(filters.query);
    if (match === '') {
      return { items: [], total: 0, offset: filters.offset, limit: filters.limit };
    }

    const structured: QueryFilter[] = [];
    if (filters.congress !== undefined) {
      structured.push({ column: 'congress', op: 'eq', value: filters.congress });
    }
    if (filters.billType) {
      structured.push({ column: 'billType', op: 'eq', value: filters.billType });
    }
    if (filters.originChamber) {
      structured.push({ column: 'originChamber', op: 'eq', value: filters.originChamber });
    }

    ctx.log.debug('Searching bill mirror', {
      match,
      filters: structured.length,
      limit: filters.limit,
      offset: filters.offset,
    });

    const result = await this.mirror.query({
      match,
      ...(structured.length > 0 ? { filters: structured } : {}),
      sort: 'relevance',
      limit: filters.limit,
      offset: filters.offset,
    });

    return {
      items: result.rows.map(toSearchResult),
      total: result.total,
      offset: filters.offset,
      limit: filters.limit,
    };
  }
}

// --- Init/accessor pattern ---

let _service: CongressMirrorService | undefined;

/** Initialize the mirror service. Call once in `createApp`'s `setup()` (when enabled). */
export function initCongressMirror(options: CongressMirrorOptions): CongressMirrorService {
  _service = new CongressMirrorService(options);
  return _service;
}

/** Access the initialized mirror service. */
export function getCongressMirror(): CongressMirrorService {
  if (!_service) {
    throw new Error(
      'CongressMirrorService not initialized — call initCongressMirror() in setup().',
    );
  }
  return _service;
}

/** Reset the singleton — test-only. */
export function resetCongressMirror(): void {
  _service = undefined;
}

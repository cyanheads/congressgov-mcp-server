/**
 * @fileoverview The Congress bill ingester — the one irreducibly per-source part
 * of the mirror. Merges two upstream Congress.gov sources into one row per bill:
 * the bill list (`/bill/{congress}`, sorted by updateDate) supplies the skeleton
 * (title, chamber, latest action, update date); the CRS summaries list
 * (`/summaries/{congress}`) supplies the summary text. Both reuse the existing
 * `CongressApiService` — no new HTTP-calling code, only merge/orchestration.
 *
 * Merge order matters: the framework upsert writes every declared column for each
 * record, so a partial (summary-only) upsert would null the title. The summaries
 * are therefore loaded into a per-congress map first, then attached as each full
 * bill row is emitted. Every sync re-walks a congress's whole summaries list, so a
 * re-emitted bill never loses a previously-stored summary: the list is requested
 * from the congress's first day with no end, because without `fromDateTime`
 * Congress.gov returns only the last day's summaries, and summaries keep being
 * rewritten long after their congress ends. The durable checkpoint is the bills'
 * `updateDate` high-water mark across every congress, persisted only once the
 * whole walk finishes; refresh re-scans bills from it inclusively
 * (`sort=updateDate asc`), and the upsert makes the overlap harmless.
 * @module services/congress-mirror/ingest
 */

import type {
  MirrorRow,
  SyncContext,
  SyncGenerator,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import type { CongressApiService } from '@/services/congress-api/congress-api-service.js';
import { congressFirstYear } from '@/utils/congress-calendar.js';
import { htmlToPlainText } from './normalize.js';

/** Congress.gov list endpoints cap the page size at 250 (confirmed live). */
const PAGE_SIZE = 250;

/** The two service methods the ingester needs — injectable so tests can mock the API. */
export type MirrorApi = Pick<CongressApiService, 'listBills' | 'listSummaries'>;

type ApiRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ApiRecord {
  return typeof value === 'object' && value !== null;
}

/** Read a non-empty string (or a stringified number) from a raw field. */
function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return;
}

/** Read an integer from a raw field (number or numeric string). */
function int(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return;
}

/**
 * Derive the composite primary key. Matches the existing
 * `congress://bill/{congress}/{billType}/{billNumber}` resource addressing; the
 * bill type is lowercased so both upstream sources key identically.
 */
function deriveBillId(congress: number, billType: string, billNumber: number): string {
  return `${congress}/${billType.toLowerCase()}/${billNumber}`;
}

/**
 * The bill list emits date-only `updateDate` ("2026-06-30"); the API's
 * `fromDateTime` filter wants full ISO 8601. Widen a date-only checkpoint to the
 * start of that day so the inclusive re-scan catches same-day updates.
 */
function toFromDateTime(checkpoint: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(checkpoint) ? `${checkpoint}T00:00:00Z` : checkpoint;
}

/** January 1 of a congress's first year as a `fromDateTime` that no summary of its bills predates. */
function congressStartDateTime(congress: number): string {
  return `${congressFirstYear(congress)}-01-01T00:00:00Z`;
}

/**
 * Page the CRS summaries list for one congress into a `billId → plain-text
 * summary` map, keeping the latest version per bill (by summary update/action
 * stamp). The window opens on the congress's first day with no end. The walk
 * keeps the upstream newest-first order: a summary updated mid-walk moves to the
 * front and at worst repeats a row, where oldest-first it would move to the end
 * and the row crossing the next page boundary would be skipped. Summaries ship as
 * HTML and are stripped to plain text before storage.
 */
async function buildSummaryMap(
  api: MirrorApi,
  congress: number,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const latest = new Map<string, { text: string; stamp: string }>();
  const fromDateTime = congressStartDateTime(congress);
  let offset = 0;
  while (!signal.aborted) {
    const result = await api.listSummaries({ congress, limit: PAGE_SIZE, offset, fromDateTime });
    const rows = result.data;
    if (rows.length === 0) break;
    for (const raw of rows) {
      if (!isRecord(raw) || !isRecord(raw.bill)) continue;
      const bill = raw.bill;
      const c = int(bill.congress);
      const billType = str(bill.type)?.toLowerCase();
      const billNumber = int(bill.number);
      if (c === undefined || billType === undefined || billNumber === undefined) continue;
      const text = typeof raw.text === 'string' ? htmlToPlainText(raw.text) : '';
      if (!text) continue;
      const id = deriveBillId(c, billType, billNumber);
      const stamp = str(raw.updateDate) ?? str(raw.actionDate) ?? '';
      const existing = latest.get(id);
      if (!existing || stamp >= existing.stamp) latest.set(id, { text, stamp });
    }
    if (rows.length < PAGE_SIZE || result.pagination.nextOffset == null) break;
    offset += PAGE_SIZE;
  }
  const map = new Map<string, string>();
  for (const [id, value] of latest) map.set(id, value.text);
  return map;
}

/** Map one raw bill-list record to a full mirror row, joining the summary map. */
function toBillRow(
  raw: ApiRecord,
  fallbackCongress: number,
  summaries: Map<string, string>,
): MirrorRow | null {
  const billType = str(raw.type)?.toLowerCase();
  const billNumber = int(raw.number);
  if (billType === undefined || billNumber === undefined) return null;
  const congress = int(raw.congress) ?? fallbackCongress;
  const id = deriveBillId(congress, billType, billNumber);
  const latestAction = isRecord(raw.latestAction) ? raw.latestAction : undefined;
  return {
    billId: id,
    congress,
    billType,
    billNumber,
    title: str(raw.title) ?? null,
    summary: summaries.get(id) ?? null,
    originChamber: str(raw.originChamber) ?? null,
    latestActionDate: latestAction ? (str(latestAction.actionDate) ?? null) : null,
    latestActionText: latestAction ? (str(latestAction.text) ?? null) : null,
    updateDate: str(raw.updateDate) ?? null,
  };
}

/**
 * Build the Congress bill ingester. The returned generator walks the configured
 * congresses; for each, it loads the summary map, then streams bill pages
 * (`sort=updateDate asc`) as full merged rows. The durable checkpoint — the max
 * `updateDate` seen across every congress — rides only the final page, so a run
 * that fails partway leaves the stored checkpoint where it started: a mid-walk
 * checkpoint could already sit past the unvisited updates of a later congress,
 * and the next refresh would skip them.
 *
 * @param getApi - Accessor for the Congress API service (injectable for tests).
 * @param congresses - Congress numbers to mirror.
 */
export function createCongressBillIngester(
  getApi: () => MirrorApi,
  congresses: number[],
): SyncGenerator {
  return async function* sync({ mode, checkpoint, signal }: SyncContext): AsyncGenerator<SyncPage> {
    const api = getApi();
    const fromDateTime = mode === 'refresh' && checkpoint ? toFromDateTime(checkpoint) : undefined;
    let maxUpdate: string | undefined = checkpoint;
    // Each page is yielded one fetch late, so the last one can carry the checkpoint.
    let held: MirrorRow[] | undefined;
    logger.info(
      `Congress bill mirror sync starting (mode=${mode}, congresses=${congresses.join(',')}${
        fromDateTime ? `, since=${fromDateTime}` : ''
      })`,
    );

    for (const congress of congresses) {
      if (signal.aborted) return;
      const summaries = await buildSummaryMap(api, congress, signal);
      logger.info(`Congress ${congress}: ${summaries.size} summaries loaded`);

      let offset = 0;
      let billsMirrored = 0;
      while (!signal.aborted) {
        const result = await api.listBills({
          congress,
          sort: 'updateDate asc',
          limit: PAGE_SIZE,
          offset,
          ...(fromDateTime ? { fromDateTime } : {}),
        });
        const rows = result.data;
        if (rows.length === 0) break;

        const records: MirrorRow[] = [];
        for (const raw of rows) {
          if (!isRecord(raw)) continue;
          const record = toBillRow(raw, congress, summaries);
          if (!record) continue;
          records.push(record);
          const updated = typeof record.updateDate === 'string' ? record.updateDate : undefined;
          if (updated && (maxUpdate === undefined || updated > maxUpdate)) maxUpdate = updated;
        }
        billsMirrored += records.length;
        if (held) yield { records: held };
        held = records;

        if (rows.length < PAGE_SIZE || result.pagination.nextOffset == null) break;
        offset += PAGE_SIZE;
      }
      logger.info(`Congress ${congress}: ${billsMirrored} bills mirrored`);
    }
    if (held && !signal.aborted) {
      yield { records: held, ...(maxUpdate ? { checkpoint: maxUpdate } : {}) };
    }
  };
}

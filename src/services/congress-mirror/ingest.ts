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
 * rewritten long after their congress ends.
 *
 * The bill list never pages by offset. It sorts and filters on a second-resolution
 * update time that each row shows only as its UTC date, with no tiebreaker, and a
 * batch update stamps dozens of bills with one second; the order inside such a tie
 * changes with `offset` and `limit`, so a page boundary that splits it repeats some
 * bills and drops others. The walk instead requests one full page at a time from a
 * cursor day and keeps only the days that page holds completely (see `walkBills`).
 *
 * The durable checkpoint is `YYYY-MM-DD|congresses` (see `formatCheckpoint`): the
 * highest list date the walks have seen, and the congresses walked completely up
 * to it. It is persisted only once the whole walk finishes. A refresh re-walks each
 * covered congress from the start of the checkpoint day and any other configured
 * congress from its own start; the upsert makes the overlap harmless.
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
import { congressFirstYear, ordinal } from '@/utils/congress-calendar.js';
import { htmlToPlainText } from './normalize.js';

/** Congress.gov list endpoints cap the page size at 250 (confirmed live). */
const PAGE_SIZE = 250;

const DAY_SECONDS = 86_400;

/** A bill-list row's `updateDate`: the UTC date of the time the list sorts on. */
const LIST_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD|ccc,ccc` — see `formatCheckpoint`. */
const CHECKPOINT = /^(\d{4}-\d{2}-\d{2})\|(\d{3}(?:,\d{3})*)$/;

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

/** January 1 of a congress's first year — no bill or summary of the congress predates it. */
function congressStartDay(congress: number): string {
  return `${congressFirstYear(congress)}-01-01`;
}

/** January 1 of a congress's first year as a `fromDateTime` that no summary of its bills predates. */
function congressStartDateTime(congress: number): string {
  return `${congressStartDay(congress)}T00:00:00Z`;
}

/** Epoch seconds at 00:00:00Z of a `YYYY-MM-DD` date. */
function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

/** Epoch seconds as the whole-second form the date filters accept; they reject fractions. */
function isoSecond(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/** A bill-list row's update date. The walk can't place a row without one, so its absence fails the sync. */
function listDate(row: ApiRecord | undefined): string {
  const date = row?.updateDate;
  if (typeof date === 'string' && LIST_DATE.test(date)) return date;
  throw new Error(
    `Congress.gov returned a bill-list row without a YYYY-MM-DD updateDate (got ${JSON.stringify(date)}), so the bill walk cannot place it.`,
  );
}

/**
 * The refresh checkpoint: `YYYY-MM-DD|ccc,ccc`. Every bill of each listed
 * congress whose update time is before that date's 00:00:00Z is stored at its
 * current version, which stays true as bills update (an update only moves a bill
 * later), so a refresh walks those congresses from the start of that day.
 * Congresses are zero-padded and listed in descending order so that, on one date,
 * a checkpoint covering more congresses compares greater: the framework runner
 * stores a page's checkpoint only when it compares greater than the stored one.
 */
function formatCheckpoint(date: string, congresses: Iterable<number>): string {
  const listed = [...new Set(congresses)]
    .sort((a, b) => b - a)
    .map((congress) => String(congress).padStart(3, '0'));
  return `${date}|${listed.join(',')}`;
}

function parseCheckpoint(checkpoint: string): { congresses: number[]; date: string } {
  const match = CHECKPOINT.exec(checkpoint);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      `The stored bill mirror checkpoint "${checkpoint}" is not the YYYY-MM-DD|congresses form this version writes.`,
    );
  }
  return { date: match[1], congresses: match[2].split(',').map(Number) };
}

/**
 * One bill-list request: offset 0, a full page, oldest first, between exclusive
 * whole-second bounds (`to` omitted for an open end). Answers with that page's
 * rows and the window's total count.
 */
type ListWindow = (from: number, to?: number) => Promise<{ count: number; rows: ApiRecord[] }>;

/**
 * Walk a congress's bill list from the start of `startDay` to its end, yielding
 * every bill updated since once. A bill updated during the walk moves to a later
 * time: past the cursor it is read again; inside the halved windows of the
 * current day it can land in a window already read, and the next refresh, which
 * re-walks the checkpoint day, reads it. Every request is offset 0:
 *
 * - From a cursor day, request with `fromDateTime` one second before it (the bound
 *   is exclusive) and no end. A count of 250 or less is the rest of the walk.
 * - Otherwise the page's rows dated before its last row's date are complete — the
 *   list is in time order and the last row's time falls on or after that date's
 *   start — so keep those and move the cursor to that date.
 * - A full page of one date walks that day as halved windows (`walkWindow`), then
 *   moves the cursor to the next day.
 */
async function* walkBills(
  list: ListWindow,
  congress: number,
  startDay: string,
  signal: AbortSignal,
): AsyncGenerator<ApiRecord[]> {
  let cursor = dayStart(startDay);
  while (!signal.aborted) {
    const { rows, count } = await list(cursor - 1);
    if (count <= PAGE_SIZE) {
      yield rows;
      return;
    }
    const first = listDate(rows[0]);
    const last = listDate(rows.at(-1));
    if (first === last) {
      const day = dayStart(last);
      yield* walkWindow(list, congress, day - 1, day + DAY_SECONDS, signal);
      cursor = day + DAY_SECONDS;
    } else {
      yield rows.filter((row) => listDate(row) < last);
      cursor = dayStart(last);
    }
  }
}

/**
 * Walk the exclusive window `(from, to)`, halving it at its midpoint second `m`
 * into `(from, m + 1)` and `(m, to)` — disjoint and gap-free under exclusive
 * whole-second bounds — while it holds more than a page. A one-second window
 * over a page can't be split further, and paging it by offset is the defect this
 * walk avoids, so it fails the sync.
 */
async function* walkWindow(
  list: ListWindow,
  congress: number,
  from: number,
  to: number,
  signal: AbortSignal,
): AsyncGenerator<ApiRecord[]> {
  if (signal.aborted) return;
  const { rows, count } = await list(from, to);
  if (count <= PAGE_SIZE) {
    yield rows;
    return;
  }
  if (to - from <= 2) {
    throw new Error(
      `Congress.gov lists ${count} bills of the ${ordinal(congress)} Congress updated in the one second ${isoSecond(from + 1)}, more than the ${PAGE_SIZE} one request returns, so the bill walk cannot read them without offset paging, which skips and repeats bills inside a tie. The sync stopped; the stored checkpoint is unchanged.`,
    );
  }
  const mid = Math.floor((from + to) / 2);
  yield* walkWindow(list, congress, from, mid + 1, signal);
  yield* walkWindow(list, congress, mid, to, signal);
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
 * congresses; for each, it loads the summary map, then streams the bill walk
 * (`walkBills`) as full merged rows — on refresh from the checkpoint day for a
 * congress the checkpoint covers, otherwise (and on init) from the congress's
 * start. The checkpoint rides only the final page, so a run that fails partway
 * leaves the stored one where it started: a mid-walk checkpoint could already sit
 * past the unvisited updates of a later congress, and the next refresh would skip
 * them. It names the configured congresses, plus those the stored checkpoint
 * covered when its date has not moved, so a congress added to the configuration
 * is walked from its start until a run completes with it.
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
    const stored = checkpoint === undefined ? undefined : parseCheckpoint(checkpoint);
    let through = stored?.date;
    // Each page is yielded one fetch late, so the last one can carry the checkpoint.
    let held: MirrorRow[] | undefined;
    logger.info(
      `Congress bill mirror sync starting (mode=${mode}, congresses=${congresses.join(',')}${
        checkpoint ? `, checkpoint=${checkpoint}` : ''
      })`,
    );

    for (const congress of congresses) {
      if (signal.aborted) return;
      const summaries = await buildSummaryMap(api, congress, signal);
      logger.info(`Congress ${congress}: ${summaries.size} summaries loaded`);

      const startDay =
        mode === 'refresh' && stored?.congresses.includes(congress)
          ? stored.date
          : congressStartDay(congress);
      let requests = 0;
      const list: ListWindow = async (from, to) => {
        requests += 1;
        const result = await api.listBills({
          congress,
          sort: 'updateDate asc',
          limit: PAGE_SIZE,
          fromDateTime: isoSecond(from),
          ...(to === undefined ? {} : { toDateTime: isoSecond(to) }),
        });
        return { rows: result.data, count: result.pagination.count };
      };

      let billsMirrored = 0;
      for await (const rows of walkBills(list, congress, startDay, signal)) {
        const records: MirrorRow[] = [];
        for (const raw of rows) {
          const date = listDate(raw);
          if (through === undefined || date > through) through = date;
          const record = toBillRow(raw, congress, summaries);
          if (record) records.push(record);
        }
        if (records.length === 0) continue;
        billsMirrored += records.length;
        if (held) yield { records: held };
        held = records;
      }
      logger.info(
        `Congress ${congress}: ${billsMirrored} bills mirrored from ${startDay} in ${requests} bill-list requests`,
      );
    }
    if (signal.aborted || through === undefined) return;
    const coveredNow = new Set(congresses);
    if (stored && through === stored.date) {
      for (const congress of stored.congresses) coveredNow.add(congress);
    }
    yield { records: held ?? [], checkpoint: formatCheckpoint(through, coveredNow) };
  };
}

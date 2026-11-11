/**
 * @fileoverview The committee roster — every committee Congress.gov lists, paged
 * past the 250-row request cap — and the chamber a committee code is read in.
 * `congressgov_committee_lookup` and the `congress://committee/{committeeCode}`
 * resource read committees through it. Each function composes single-request
 * `CongressApiService` calls; the service class itself stays one request per method.
 * @module services/congress-api/committee-roster
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';

import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import type { Chamber } from '@/services/congress-api/types.js';

type ApiRecord = Record<string, unknown>;

const PAGE_SIZE = 250;

/** The chamber lists the cross-chamber roster is read from. */
const CHAMBERS = ['house', 'senate', 'joint'] as const satisfies readonly Chamber[];

type RosterScope = { congress?: number | undefined; chamber?: Chamber | undefined };

/** The chamber a code's first letter names (h=House, s=Senate, j=Joint); undefined for any other letter. */
export function inferChamberFromCode(code: string): Chamber | undefined {
  const first = code[0]?.toLowerCase();
  if (first === 's') return 'senate';
  if (first === 'j') return 'joint';
  if (first === 'h') return 'house';
  return;
}

/**
 * A roster row's own chamber ('House', 'Senate', 'Joint'). Some codes disagree
 * with their prefix — `jsat00`, `jtdr00`, and `jsec03` are Senate committees —
 * and the historical `n…` codes (`n79043125`, `no2010049600`) name no chamber at
 * all, so a committee is read in the chamber its row lists.
 */
export function rosterChamber(record: ApiRecord): Chamber | undefined {
  switch (typeof record.chamber === 'string' ? record.chamber.toLowerCase() : undefined) {
    case 'house':
      return 'house';
    case 'senate':
      return 'senate';
    case 'joint':
      return 'joint';
    default:
      return;
  }
}

/**
 * Fetch the complete committee set for a scope, each committee once, newest
 * update first. `/committee[/{chamber}]` lists the full historical roster — 455
 * House, 327 Senate, and 36 Joint committees — but one request returns at most
 * 250 rows, so a scope is paged to its end.
 *
 * Every list orders rows by update date, and Congress.gov orders the rows that
 * share one afresh on each page request. A page boundary inside such a group
 * can hand both pages the same row and neither page another: the cross-chamber
 * `/committee` list does this on every read, losing `no94026591`. So the roster
 * with no chamber or congress is read as the three chamber lists, concurrently,
 * and any scope whose pages repeat a row is read again at its boundaries.
 */
export async function fetchAllCommittees(params: RosterScope, ctx: Context) {
  const scopes =
    params.chamber === undefined && params.congress === undefined
      ? await Promise.all(CHAMBERS.map((chamber) => fetchScope({ chamber }, ctx)))
      : [await fetchScope(params, ctx)];
  const data = distinctRows(scopes.flatMap((scope) => scope.data)).toSorted(newestFirst);
  const count = scopes.reduce((total, scope) => total + scope.count, 0);
  return { data, pagination: { count, nextOffset: null } };
}

/**
 * Page one scope to its end. Full pages each return as many rows as they skip
 * past, so a row two pages repeat means a tied group straddles a boundary and
 * another row fell between them. Then every boundary is read again with one page
 * centred on it, which holds the whole group, and the rows it adds are kept.
 */
async function fetchScope(
  scope: RosterScope,
  ctx: Context,
): Promise<{ data: ApiRecord[]; count: number }> {
  const api = getCongressApi();
  const pages: ApiRecord[][] = [];
  const boundaries: number[] = [];
  let count = 0;

  for (let offset = 0; ; ) {
    const page = await api.listCommittees({ ...scope, limit: PAGE_SIZE, offset }, ctx);
    pages.push(page.data as ApiRecord[]);
    count = page.pagination.count;
    if (page.pagination.nextOffset == null) break;
    offset = page.pagination.nextOffset;
    boundaries.push(offset);
  }

  const read = pages.flat();
  const data = distinctRows(read);
  if (data.length === read.length) return { data, count };

  const centred = await Promise.all(
    boundaries.map((boundary) =>
      api.listCommittees({ ...scope, limit: PAGE_SIZE, offset: boundary - PAGE_SIZE / 2 }, ctx),
    ),
  );
  const repaired = distinctRows([...data, ...centred.flatMap((page) => page.data as ApiRecord[])]);
  ctx.log.info('Committee roster re-read at its page boundaries', {
    ...scope,
    boundaries,
    repeatedRows: read.length - data.length,
    restoredRows: repaired.length - data.length,
  });
  return { data: repaired, count };
}

/** `rows` with each `systemCode` kept at its first appearance. */
function distinctRows(rows: readonly ApiRecord[]): ApiRecord[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (typeof row.systemCode !== 'string') return true;
    if (seen.has(row.systemCode)) return false;
    seen.add(row.systemCode);
    return true;
  });
}

/** Newest `updateDate` first, as Congress.gov lists committees; rows of one instant keep their order. */
function newestFirst(a: ApiRecord, b: ApiRecord): number {
  const left = String(a.updateDate ?? '');
  const right = String(b.updateDate ?? '');
  return left === right ? 0 : left < right ? 1 : -1;
}

/** The roster row whose `systemCode` equals `code`, compared case-insensitively. */
export function findRosterRow(rows: readonly ApiRecord[], code: string): ApiRecord | undefined {
  const wanted = code.toLowerCase();
  return rows.find(
    (row) => typeof row.systemCode === 'string' && row.systemCode.toLowerCase() === wanted,
  );
}

/** The chamber the cross-chamber roster lists `code` under; undefined when no row carries it. */
export async function listedChamber(code: string, ctx: Context): Promise<Chamber | undefined> {
  const row = findRosterRow((await fetchAllCommittees({}, ctx)).data, code);
  return row && rosterChamber(row);
}

/**
 * Run a committee read in the chamber that holds `committeeCode`, returning the
 * chamber read. The prefix's chamber goes first, so a code that chamber holds
 * costs one request. Only a not_found there, or a prefix that names no chamber,
 * reads the roster and runs the read in the chamber the code's row lists. A code
 * the roster lacks, or lists under the chamber already tried, keeps that
 * chamber's not_found; with no chamber tried, it fails not_found here. The catch
 * is recovery — the not_found picks the next chamber — not error handling.
 */
export async function readCommittee<T>(
  committeeCode: string,
  read: (chamber: Chamber) => Promise<T>,
  ctx: Context,
): Promise<{ value: T; chamber: Chamber }> {
  const prefix = inferChamberFromCode(committeeCode);
  if (prefix) {
    try {
      return { value: await read(prefix), chamber: prefix };
    } catch (error) {
      if (!(error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)) throw error;
      const listed = await listedChamber(committeeCode, ctx);
      if (listed === undefined || listed === prefix) throw error;
      return { value: await read(listed), chamber: listed };
    }
  }
  const listed = await listedChamber(committeeCode, ctx);
  if (listed === undefined) {
    throw notFound(
      `Committee ${committeeCode} is not in the committee roster. Call \`congressgov_committee_lookup\` with \`operation: 'list'\` and an optional \`filter\` to discover valid codes.`,
      { committeeCode },
    );
  }
  return { value: await read(listed), chamber: listed };
}

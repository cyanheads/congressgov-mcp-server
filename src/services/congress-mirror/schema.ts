/**
 * @fileoverview Mirror store schema for the Congress bill FTS index. A single
 * MirrorService-owned table (`bills`) with an FTS5 index over `title` + `summary`
 * and secondary indexes on the filterable columns. The primary key is the derived
 * `billId` (`{congress}/{billType}/{billNumber}`) — a single column, matching the
 * `congress://bill/{congress}/{billType}/{billNumber}` resource addressing.
 * @module services/congress-mirror/schema
 */

import type { Migration, SqliteMirrorStoreSpec } from '@cyanheads/mcp-ts-core/mirror';

/** Primary table name (the MirrorService-owned table). */
export const BILLS_TABLE = 'bills';

/**
 * Clear the refresh checkpoint, so the next refresh walks every configured
 * congress from its start; the completion marker stays, so search keeps serving
 * throughout. A no-op on a fresh store, which has no checkpoint yet.
 *
 * - Version 2 backfills summaries: stores built before it requested the summaries
 *   list without a date window, so every stored summary is null.
 * - Version 3 recovers the bills the offset-paged bill walk skipped (a skipped
 *   bill's update time doesn't change, so no refresh revisits it) and drops the
 *   date-only checkpoint, which names no congresses.
 */
function clearRefreshCheckpoint(version: number): Migration {
  return {
    version,
    up(handle) {
      handle.prepare('UPDATE mirror_sync_state SET checkpoint = NULL WHERE id = 1').run();
    },
  };
}

/**
 * The MirrorService primary-table spec. One row per bill, merged from the bill
 * list (title, chamber, latest action, update date) and the CRS summaries list
 * (summary text). `title` + `summary` are FTS-indexed; `congress`, `billType`,
 * and `originChamber` back the exact-match search filters.
 */
export function billStoreSpec(path: string): SqliteMirrorStoreSpec {
  return {
    path,
    table: BILLS_TABLE,
    primaryKey: 'billId',
    version: 3,
    migrations: [clearRefreshCheckpoint(2), clearRefreshCheckpoint(3)],
    columns: {
      billId: 'TEXT',
      congress: 'INTEGER',
      billType: 'TEXT',
      billNumber: 'INTEGER',
      title: 'TEXT',
      summary: 'TEXT',
      originChamber: 'TEXT',
      latestActionDate: 'TEXT',
      latestActionText: 'TEXT',
      updateDate: 'TEXT',
    },
    fts: ['title', 'summary'],
    indexes: [
      { columns: ['congress'] },
      { columns: ['billType'] },
      { columns: ['originChamber'] },
      { columns: ['updateDate'] },
    ],
  };
}

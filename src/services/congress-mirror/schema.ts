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
 * Version 2 backfills summaries. Stores built before it requested the summaries
 * list without a date window, so every stored summary is null, and a refresh only
 * re-emits bills updated since the checkpoint. Clearing the checkpoint makes the
 * next refresh re-walk every bill; the completion marker stays, so search keeps
 * serving throughout. A no-op on a fresh store, which has no checkpoint yet.
 */
const clearRefreshCheckpoint: Migration = {
  version: 2,
  up(handle) {
    handle.prepare('UPDATE mirror_sync_state SET checkpoint = NULL WHERE id = 1').run();
  },
};

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
    version: 2,
    migrations: [clearRefreshCheckpoint],
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

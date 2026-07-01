/**
 * @fileoverview Mirror store schema for the Congress bill FTS index. A single
 * MirrorService-owned table (`bills`) with an FTS5 index over `title` + `summary`
 * and secondary indexes on the filterable columns. The primary key is the derived
 * `billId` (`{congress}/{billType}/{billNumber}`) — a single column, matching the
 * `congress://bill/{congress}/{billType}/{billNumber}` resource addressing.
 * @module services/congress-mirror/schema
 */

import type { SqliteMirrorStoreSpec } from '@cyanheads/mcp-ts-core/mirror';

/** Primary table name (the MirrorService-owned table). */
export const BILLS_TABLE = 'bills';

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
    version: 1,
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

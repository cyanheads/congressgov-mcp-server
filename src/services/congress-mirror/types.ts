/**
 * @fileoverview Domain types for the Congress bill FTS mirror — the merged row
 * shape, the search filters, and the search page envelope. The mirror row is the
 * single-table projection of two upstream Congress.gov sources (the bill list and
 * the CRS summaries list) keyed by a derived `billId`.
 * @module services/congress-mirror/types
 */

import type { BillType } from '@/services/congress-api/types.js';

/**
 * One mirrored bill — a flat row keyed by the derived `billId`
 * (`{congress}/{billType}/{billNumber}`). `title` comes from the bill list;
 * `summary` from the CRS summaries list (HTML-stripped, latest version), nullable
 * because CRS summarizes only a fraction of bills.
 */
export interface BillMirrorRow {
  billId: string;
  billNumber: number;
  billType: string;
  congress: number;
  latestActionDate: string | null;
  latestActionText: string | null;
  originChamber: string | null;
  summary: string | null;
  title: string | null;
  updateDate: string | null;
}

/** Filters accepted by the keyword search. */
export interface SearchBillsFilters {
  billType?: BillType | undefined;
  congress?: number | undefined;
  limit: number;
  offset: number;
  originChamber?: string | undefined;
  query: string;
}

/** A single search result — a merged mirror row projected for display. */
export interface SearchBillResult {
  billId: string;
  billNumber: number;
  billType: string;
  congress: number;
  latestActionDate?: string;
  latestActionText?: string;
  originChamber?: string;
  summaryPreview?: string;
  title: string;
}

/** Search page returned by the mirror service. */
export interface SearchBillsPage {
  items: SearchBillResult[];
  limit: number;
  offset: number;
  total: number;
}

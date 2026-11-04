/**
 * @fileoverview Domain types for bounded retrieval of Congress.gov document text.
 * @module services/congress-documents/types
 */

/** The document formats this server retrieves. PDF is deliberately absent — extraction cost. */
export type DocumentFormat = 'text' | 'xml';

/**
 * How a document body becomes the plain text offsets index into. The caller
 * that resolved the URL names the reading; it is never sniffed from the body.
 *
 * - `gpo` — GPO publications (bill text, committee reports, Congressional
 *   Record articles): Formatted Text `<pre>` print output kept verbatim, or XML
 *   with one space at an unseparated structural sibling boundary, decided by
 *   whether the body carries a `<pre>`.
 * - `html` — a rendered web page (CRS reports): script and style dropped,
 *   whitespace collapsed, and block elements laid out as lines and paragraphs.
 */
export type DocumentReading = 'gpo' | 'html';

/**
 * One entry of an upstream format list. Bill text versions and committee reports
 * carry these under `formats[]`; Daily Congressional Record articles carry the
 * same `{type, url}` pairs under `text[]`. Every field is optional — upstream
 * rows are sparse and untyped at this boundary.
 */
export interface DocumentFormatRef {
  isErrata?: unknown;
  type?: unknown;
  url?: unknown;
}

/**
 * One entry of a CRS report's `formats[]`: the label sits under `format`
 * (`HTML`, `PDF`), not the `type` the GPO format lists use.
 */
export interface CrsFormatRef {
  format?: unknown;
  url?: unknown;
}

/** Parameters for a single bounded document read. */
export interface FetchDocumentParams {
  /** Maximum characters to return. */
  characterLimit: number;
  /** First character of the document to return, 0-based. */
  characterOffset: number;
  /** The reading the body gets — named by the caller that resolved the URL. */
  reading: DocumentReading;
  /** Absolute URL resolved from upstream metadata — never caller-supplied. */
  url: string;
}

/**
 * A bounded window onto one document's plain text.
 *
 * `offset` + `text.length` is exactly `nextOffset` when more remains, so feeding
 * `nextOffset` back walks the document with no overlap and no gap.
 */
export interface DocumentContent {
  /** Offset to pass next, or null at the end of the document. */
  nextOffset: number | null;
  /** Echo of the requested start offset. */
  offset: number;
  /** The requested character window, verbatim. */
  text: string;
  /** Characters in the whole document, not this window. */
  totalCharacters: number;
  /** True when characters remain past this window. */
  truncated: boolean;
}

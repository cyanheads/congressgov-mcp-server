/**
 * @fileoverview The per-row character window both summary surfaces apply to
 * one summary's upstream HTML `text`.
 *
 * Upstream publishes a summary past two hundred thousand characters for an
 * omnibus bill, so each row's `text` is bounded on its own and `textNextOffset`
 * carries the rest of that row. The page is left as the caller's `limit` shaped
 * it — every row, and the upstream `pagination` — and a row inside the window is
 * returned untouched, so a page with no oversized row is byte-identical to one
 * this module never saw.
 *
 * @module mcp-server/tools/summary-window
 */

import { DEFAULT_SUMMARY_TEXT_CHARACTERS } from '@/mcp-server/tools/tool-helpers.js';

/** One upstream summary row. Congress.gov shapes vary, so the record stays open. */
type SummaryRow = Record<string, unknown>;

/** The paginated envelope both summary surfaces return. */
export interface SummaryPage {
  data: SummaryRow[];
  pagination: { count: number; nextOffset: number | null };
  [key: string]: unknown;
}

/** A row whose `text` was replaced by a window of itself. */
export interface WindowedSummaryRow {
  /** One past the last character returned. */
  end: number;
  /** The row's 0-based position in the returned page. */
  index: number;
  /** Where the next window starts, or null once the text has been read to the end. */
  nextOffset: number | null;
  row: SummaryRow;
  /** First character returned, 0-based. */
  start: number;
  /** Characters of the upstream `text`. */
  totalCharacters: number;
}

export interface SummaryWindowResult {
  /**
   * The page carries rows, every one of them holds text, and `characterOffset`
   * is at or past the end of all of them — no window could be non-empty.
   */
  offsetPastEnd: boolean;
  /** The envelope to return — every row, each one windowed, and nothing else. */
  page: SummaryPage;
  /** Every row whose `text` was windowed, in page order. */
  windowed: WindowedSummaryRow[];
}

export interface SummaryWindowOptions {
  /** Maximum characters of one row's text to return. */
  characterLimit?: number;
  /** First character of each row's text to return, 0-based. */
  characterOffset?: number;
}

/**
 * Longest span a pending character reference is scanned back over.
 * `&#x10FFFF;` and `&#1114111;` are the longest unpadded forms this server's
 * decoder resolves (`src/utils/character-references.ts`), so a longer run of
 * reference characters reads as a stray `&` and the window ends where it was
 * asked to. A zero-padded reference wider than this renders split across two
 * windows; the walk is unaffected, since the next window resumes exactly where
 * this one ended.
 */
const MAX_REFERENCE_SPAN = 12;

/** Characters that may sit between a reference's `&` and its `;`. */
const REFERENCE_BODY = /[#0-9A-Za-z]/;

/**
 * Pull `end` back off an HTML construct the window would otherwise cut in half.
 *
 * A window that ends inside `<stro` or `&nbs` renders as literal tag text or a
 * broken entity in `content[]`, and the same fragment reappears at the head of
 * the next window. Retracting to the construct's opening character keeps every
 * window individually renderable while leaving the walk exact: the next window
 * starts where this one ended, so concatenation still reproduces the upstream
 * text character for character.
 *
 * When the construct spans the whole window — a caller asking for fewer
 * characters than one tag is long — the requested end wins. `characterLimit` is
 * an advertised bound a caller budgets against, and retracting to the window's
 * own start would return nothing and stall the walk.
 */
export function safeWindowEnd(text: string, start: number, end: number): number {
  let cut = -1;

  /** An unterminated `<`: every character from it to `end` is the head of a tag. */
  for (let i = end - 1; i >= start; i--) {
    const character = text.charAt(i);
    if (character === '>') break;
    if (character === '<') {
      cut = i;
      break;
    }
  }

  /** A pending `&`: only reference-body characters stand between it and `end`. */
  const floor = Math.max(start, end - MAX_REFERENCE_SPAN);
  for (let i = end - 1; i >= floor; i--) {
    const character = text.charAt(i);
    if (character === '&') {
      if (cut === -1 || i < cut) cut = i;
      break;
    }
    if (!REFERENCE_BODY.test(character)) break;
  }

  return cut > start ? cut : end;
}

/** The per-row window, and what it did, for one row. */
function windowRow(
  row: SummaryRow,
  characterOffset: number,
  characterLimit: number,
): { row: SummaryRow; window?: Omit<WindowedSummaryRow, 'index' | 'row'> } {
  const text = row.text;
  if (typeof text !== 'string') return { row };

  const totalCharacters = text.length;
  /** The whole text, asked for from the top: the row is the upstream row. */
  if (characterOffset === 0 && totalCharacters <= characterLimit) return { row };

  const start = Math.min(characterOffset, totalCharacters);
  const requestedEnd = Math.min(totalCharacters, start + characterLimit);
  const end =
    requestedEnd < totalCharacters ? safeWindowEnd(text, start, requestedEnd) : requestedEnd;
  const nextOffset = end < totalCharacters ? end : null;

  return {
    row: {
      ...row,
      text: text.slice(start, end),
      textTotalCharacters: totalCharacters,
      textTruncated: nextOffset !== null,
      textNextOffset: nextOffset,
    },
    window: { totalCharacters, start, end, nextOffset },
  };
}

/**
 * Window every row of a page of summaries. Rows, their order, and the upstream
 * `pagination` pass through — the caller's `limit` is the page's only bound.
 */
export function windowSummaryPage(
  page: SummaryPage,
  options: SummaryWindowOptions = {},
): SummaryWindowResult {
  const characterOffset = options.characterOffset ?? 0;
  const characterLimit = options.characterLimit ?? DEFAULT_SUMMARY_TEXT_CHARACTERS;

  const data: SummaryRow[] = [];
  const windowed: WindowedSummaryRow[] = [];
  let textRows = 0;
  let emptyWindows = 0;

  for (const upstream of page.data) {
    const { row, window } = windowRow(upstream, characterOffset, characterLimit);
    data.push(row);
    if (typeof upstream.text === 'string') {
      textRows++;
      if (window && window.start >= window.totalCharacters) emptyWindows++;
    }
    if (window) windowed.push({ index: data.length - 1, row, ...window });
  }

  return {
    page: { ...page, data },
    windowed,
    offsetPastEnd: textRows > 0 && emptyWindows === textRows,
  };
}

/** Identifiers of the bill a `congressgov_bill_lookup` continuation names. */
export interface SummaryContinuation {
  billNumber: number | string;
  billType: string;
  characterOffset: number;
  congress: number | string;
  versionCode?: string | undefined;
}

/**
 * The `congressgov_bill_lookup` call that reads the rest of a windowed row.
 *
 * Printed as the tool name plus its arguments so a caller can issue it exactly
 * as written: the bill type is lower-cased because summary rows carry the
 * upstream casing (`"HR"`) while the input enum takes the code (`"hr"`).
 */
export function summaryContinuationCall(continuation: SummaryContinuation): string {
  const args = {
    operation: 'summaries',
    congress: Number(continuation.congress),
    billType: String(continuation.billType).toLowerCase(),
    billNumber: String(continuation.billNumber),
    ...(continuation.versionCode ? { versionCode: continuation.versionCode } : {}),
    characterOffset: continuation.characterOffset,
  };
  return `congressgov_bill_lookup ${JSON.stringify(args)}`;
}

/**
 * The notice a page carries when a row's text was windowed short of its end:
 * what was returned and the call that continues from there. Returns undefined
 * when every row's text was read to its end.
 */
export function summaryWindowNotice(
  result: SummaryWindowResult,
  continuationFor: (row: WindowedSummaryRow) => string | undefined,
): string | undefined {
  const first = result.windowed.find((row) => row.nextOffset !== null);
  if (!first) return;

  const continuation = continuationFor(first);
  const more =
    result.windowed.length > 1
      ? ` ${result.windowed.length} rows on this page carry windowed text; each row's textNextOffset continues it.`
      : '';
  return `Summary text on row ${first.index + 1} runs ${first.totalCharacters.toLocaleString('en-US')} characters; characters ${(first.start + 1).toLocaleString('en-US')}–${first.end.toLocaleString('en-US')} returned.${continuation ? ` Continue with: ${continuation}` : ''}${more}`;
}

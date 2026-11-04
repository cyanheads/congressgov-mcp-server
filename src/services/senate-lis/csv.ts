/**
 * @fileoverview A one-pass RFC 4180 CSV reader for Voteview's published vote
 * files: comma-separated fields, double-quoted fields that may hold commas,
 * line breaks, and doubled quotes, and LF or CRLF row endings.
 *
 * Every character is visited once — unquoted fields by a forward scan, quoted
 * fields by `indexOf` jumps from one quote to the next — so the cost is linear in
 * the text for any input, including a field of nothing but doubled quotes.
 *
 * @module services/senate-lis/csv
 */

const COMMA = 44;
const QUOTE = 34;
const LF = 10;
const CR = 13;
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Call `onRow` with each row's fields, in order. Blank lines are skipped and a
 * trailing line break ends the last row rather than opening an empty one.
 *
 * @throws {Error} When a quoted field never closes, or a closing quote is
 * followed by anything but a comma, a line break, or the end of the text.
 */
export function readCsv(text: string, onRow: (fields: string[]) => void): void {
  const end = text.length;
  let i = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  let row: string[] = [];
  while (i < end) {
    const first = text.charCodeAt(i);
    if (row.length === 0 && (first === LF || first === CR)) {
      i++;
      continue;
    }

    if (first === QUOTE) {
      const closed = readQuoted(text, i + 1);
      row.push(closed.field);
      i = closed.next;
    } else {
      const start = i;
      while (i < end) {
        const c = text.charCodeAt(i);
        if (c === COMMA || c === LF || c === CR) break;
        i++;
      }
      row.push(text.slice(start, i));
    }

    if (i >= end) break;
    if (text.charCodeAt(i) === COMMA) {
      i++;
      /** A comma that ends the text still opens one last, empty field. */
      if (i === end) row.push('');
      continue;
    }
    i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    onRow(row);
    row = [];
  }
  if (row.length > 0) onRow(row);
}

/** Read a quoted field whose opening quote sits just before `start`. */
function readQuoted(text: string, start: number): { field: string; next: number } {
  const parts: string[] = [];
  let from = start;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1) {
      throw new Error(`CSV quoted field opened at offset ${start - 1} never closes.`);
    }
    if (text.charCodeAt(quote + 1) === QUOTE) {
      /** A doubled quote is one literal quote inside the field. */
      parts.push(text.slice(from, quote + 1));
      from = quote + 2;
      continue;
    }
    parts.push(text.slice(from, quote));
    const next = quote + 1;
    const after = text.charCodeAt(next);
    if (next < text.length && after !== COMMA && after !== LF && after !== CR) {
      throw new Error(`CSV quoted field closed at offset ${quote} is followed by more text.`);
    }
    return { field: parts.length === 1 ? (parts[0] as string) : parts.join(''), next };
  }
}

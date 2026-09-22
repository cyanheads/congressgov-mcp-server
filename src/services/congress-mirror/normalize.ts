/**
 * @fileoverview Pure normalization helpers for the bill mirror — HTML→plain-text
 * stripping (summaries ship as HTML; the FTS index and snippet surface want plain
 * text) and FTS5 `MATCH` escaping (tokenize + individually quote so a stray `-`,
 * an unbalanced quote, or an FTS5 reserved word can't break the query). No I/O.
 * @module services/congress-mirror/normalize
 */

import { decodeCharacterReferences } from '@/utils/character-references.js';

/**
 * Strip HTML tags to plain text and decode the character references Congress.gov
 * emits in summary bodies. Block-ish tags collapse to spaces so adjacent words
 * don't fuse (`</p><p>` → space), and whitespace is collapsed to single spaces —
 * a discovery/snippet surface doesn't need paragraph structure, and flat text
 * tokenizes more cleanly for FTS5.
 *
 * References decode in one pass, after the tags are gone, so text that literally
 * says `&amp;lt;` indexes as `&lt;` rather than as a tag the source never had.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/?(p|div|li|ul|ol|h[1-6]|tr|table)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeCharacterReferences(text).replace(/\s+/g, ' ').trim();
}

/**
 * Build an FTS5 `MATCH` expression from free-text input. Each token is stripped
 * of embedded quotes and wrapped in double quotes, which neutralizes every FTS5
 * operator (`-`, `*`, `:`, `NEAR`, `AND`, `OR`, `NOT`) so punctuation or a
 * reserved word can't raise a SQLite syntax error. Tokens are AND-combined
 * (implicit-AND across terms). Returns an empty string when the input has no
 * searchable tokens — callers treat that as "no match", not a thrown query.
 */
export function toFtsMatch(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(' AND ');
}

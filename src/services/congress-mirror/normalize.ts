/**
 * @fileoverview Pure normalization helpers for the bill mirror — HTML→plain-text
 * stripping (summaries ship as HTML; the FTS index and snippet surface want plain
 * text) and FTS5 `MATCH` escaping (tokenize + individually quote so a stray `-`,
 * an unbalanced quote, or an FTS5 reserved word can't break the query). No I/O.
 * @module services/congress-mirror/normalize
 */

/**
 * Strip HTML tags to plain text and decode the handful of entities Congress.gov
 * emits in summary bodies. Block-ish tags collapse to spaces so adjacent words
 * don't fuse (`</p><p>` → space), and whitespace is collapsed to single spaces —
 * a discovery/snippet surface doesn't need paragraph structure, and flat text
 * tokenizes more cleanly for FTS5.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/?(p|div|li|ul|ol|h[1-6]|tr|table)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
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

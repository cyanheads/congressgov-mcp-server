/**
 * @fileoverview Turn a Congress.gov document body into the plain text offsets
 * index into — the normative, whole-string form of each reading
 * (`DocumentReading`): {@link extractDocumentText} for GPO publications and
 * {@link extractHtmlText} for HTML pages. `extract-text-stream.ts` reproduces
 * both incrementally, laying the `html` reading out through the same
 * {@link HtmlLayout}.
 * @module services/congress-documents/extract-text
 */

import { decodeCharacterReferences } from '@/utils/character-references.js';

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]*>/g;
const XML_ELEMENT_BOUNDARY_RE =
  /(?<!<)((?:<\s*\/\s*[a-zA-Z][^>]*>)+)(?=<\s*([a-zA-Z][\w:.-]*)(?:\s|\/?>))/g;
const XML_CLOSE_TAG_RE = /<\s*\/\s*([a-zA-Z][\w:.-]*)[^>]*>/g;
/** U+0000 is no XML character, and the decoder resolves no reference to it. */
const XML_BOUNDARY_MARKER = '\0';
const INLINE_XML_TAGS = new Set(['a', 'b', 'em', 'i', 'span', 'strong', 'sub', 'sup']);

/**
 * The tag name has to end at the `>` or at whitespace. A loose `<\s*pre[^>]*>`
 * also matches USLM's `<preamble>` — which truncated a 2.6 MB bill to its
 * 223-character preamble, and reported that as the document's full length.
 */
const PRE_OPEN_RE = /<\s*pre(?:\s[^>]*)?\/?>/i;
const PRE_CLOSE_RE = /<\s*\/\s*pre\s*>/gi;

/**
 * The content between the first `<pre>` and the last `</pre>`, or `undefined`
 * when the body carries no `<pre>` block at all (every XML body, and any future
 * shape that is not GPO print output).
 */
function unwrapPre(body: string): string | undefined {
  const open = PRE_OPEN_RE.exec(body);
  if (!open) return;
  const start = open.index + open[0].length;

  let closeAt = -1;
  for (const close of body.matchAll(PRE_CLOSE_RE)) {
    if (close.index > start) closeAt = close.index;
  }
  return closeAt > start ? body.slice(start, closeAt) : body.slice(start);
}

/** Mark structural close-to-open XML boundaries before tags are stripped. */
function normalizeXmlSiblingBoundaries(xml: string): string {
  return xml.replace(XML_ELEMENT_BOUNDARY_RE, (match, closingTags: string, openName: string) => {
    let structuralClose = false;
    for (const [, closeName] of closingTags.matchAll(XML_CLOSE_TAG_RE)) {
      if (INLINE_XML_TAGS.has((closeName as string).toLowerCase())) continue;
      structuralClose = true;
      break;
    }
    const structuralOpen = !INLINE_XML_TAGS.has(openName.toLowerCase());
    return structuralClose || structuralOpen ? `${match}${XML_BOUNDARY_MARKER}` : match;
  });
}

/** Resolve a marked boundary only when visible whitespace does not already separate it. */
function resolveXmlSiblingBoundaries(text: string): string {
  let output = '';
  let pendingBoundary = false;
  for (const ch of text) {
    if (ch === XML_BOUNDARY_MARKER) {
      pendingBoundary = true;
      continue;
    }
    if (pendingBoundary) {
      if (output !== '' && !/\s/u.test(output.at(-1) as string) && !/\s/u.test(ch)) output += ' ';
      pendingBoundary = false;
    }
    output += ch;
  }
  return output;
}

/**
 * Extract the readable plain text of a Congress.gov document body.
 *
 * "Formatted Text" is not semantic HTML — it is GPO's monospace print output
 * wrapped in `<pre>`, sometimes inside `<html><body>` and sometimes bare, with
 * the occasional inline anchor and HTML-escaped entities. The pre-formatted
 * layout (column alignment, indentation, blank-line structure) is the document's
 * real structure, so whitespace is preserved verbatim rather than collapsed the
 * way `htmlToMarkdown` collapses narrative prose. XML bodies preserve one ASCII
 * space at a close-to-open sibling boundary that carried no source whitespace;
 * inline tags remain transparent.
 *
 * The result is the string every character offset indexes into, so it has to be
 * deterministic: line endings are normalized to `\n` before anything else, and
 * the transform is applied once per fetch.
 */
export function extractDocumentText(body: string): string {
  const normalized = body.replace(/\r\n?/g, '\n');
  const stripped = normalized.replace(COMMENT_RE, '');
  const pre = unwrapPre(stripped);
  if (pre !== undefined) return decodeCharacterReferences(pre.replace(TAG_RE, '')).trim();
  const readable = decodeCharacterReferences(
    normalizeXmlSiblingBoundaries(stripped).replace(TAG_RE, ''),
  );
  return resolveXmlSiblingBoundaries(readable).trim();
}

/**
 * What an element does to the `html` reading's layout. An element not listed
 * is transparent: its tags vanish and the text around them runs on.
 *
 * - `paragraph` — a blank line before and after (a space inside a table cell)
 * - `line` — a line break before and after (a space inside a table cell)
 * - `row` — a line break; a table row is one line
 * - `table` — a blank line before and after; a table that opens a cell is
 *   that cell's content instead ({@link HtmlLayout})
 * - `cell` — a tab between cells of one row
 * - `raw` — `script` and `style`: dropped with everything inside them
 */
export type HtmlTagRole = 'cell' | 'line' | 'paragraph' | 'raw' | 'row' | 'table';

/** Roles by lowercase tag name. */
export const HTML_TAG_ROLES: ReadonlyMap<string, HtmlTagRole> = new Map<string, HtmlTagRole>([
  ['blockquote', 'paragraph'],
  ['br', 'line'],
  ['div', 'line'],
  ['h1', 'paragraph'],
  ['h2', 'paragraph'],
  ['h3', 'paragraph'],
  ['h4', 'paragraph'],
  ['h5', 'paragraph'],
  ['h6', 'paragraph'],
  ['hr', 'paragraph'],
  ['li', 'line'],
  ['ol', 'paragraph'],
  ['p', 'paragraph'],
  ['script', 'raw'],
  ['style', 'raw'],
  ['table', 'table'],
  ['td', 'cell'],
  ['th', 'cell'],
  ['tr', 'row'],
  ['ul', 'paragraph'],
]);

/** The longest name in {@link HTML_TAG_ROLES}; a longer tag name has no role. */
export const MAX_HTML_TAG_NAME = Math.max(...[...HTML_TAG_ROLES.keys()].map((name) => name.length));

/** ASCII whitespace as HTML defines it — tab, LF, FF, CR, space. U+00A0 is text. */
export function isHtmlWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
}

/**
 * Whitespace as `String.prototype.trim` defines it — WhiteSpace plus
 * LineTerminator, which is also exactly the `\s` character class: tab through
 * carriage return, space, U+00A0, the other Unicode spaces, and U+FEFF.
 */
export function isWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  if (code < 0x80) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

/** Lowercase A–Z only, so no other character can turn into a tag name. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/** Whether `body` holds `lowerName` at `from`, A–Z matched in either case. */
function matchesAsciiName(body: string, from: number, lowerName: string): boolean {
  for (let k = 0; k < lowerName.length; k++) {
    const code = body.charCodeAt(from + k);
    const lower = code >= 0x41 && code <= 0x5a ? code | 0x20 : code;
    if (lower !== lowerName.charCodeAt(k)) return false;
  }
  return true;
}

/** The index just past the first `>` at or after `from`, or the end of the body. */
function pastNextGt(body: string, from: number): number {
  const at = body.indexOf('>', from);
  return at === -1 ? body.length : at + 1;
}

/** A run of markup: where it ends, and the tag it was, if it was one. */
interface HtmlMarkup {
  end: number;
  tag?: { isEnd: boolean; name: string };
}

/** A start or end tag whose name begins at `nameStart`; it runs to its first `>`. */
function scanTag(body: string, nameStart: number, isEnd: boolean): HtmlMarkup {
  let nameEnd = nameStart;
  while (nameEnd < body.length) {
    const ch = body[nameEnd] as string;
    if (ch === '>' || ch === '/' || isHtmlWhitespace(ch)) break;
    nameEnd++;
  }
  const raw = body.slice(nameStart, nameEnd);
  const name = raw.length <= MAX_HTML_TAG_NAME ? asciiLowercase(raw) : '';
  return { end: pastNextGt(body, nameEnd), tag: { isEnd, name } };
}

/**
 * Where a comment opened at `lt` ends, as the HTML tokenizer ends it: at the
 * first `-->` (which may reuse the opener's dashes, so `<!-->` and `<!--->` are
 * empty comments) or the first `--!>` past the opener, else at the end of the
 * body.
 */
function commentEnd(body: string, lt: number): number {
  let from = lt + 2;
  for (;;) {
    const dashes = body.indexOf('--', from);
    if (dashes === -1) return body.length;
    if (body[dashes + 2] === '>') return dashes + 3;
    if (dashes >= lt + 4 && body[dashes + 2] === '!' && body[dashes + 3] === '>') {
      return dashes + 4;
    }
    from = dashes + 1;
  }
}

/**
 * The markup that starts at `lt`, or `undefined` when this `<` opens nothing
 * and is text. A tag starts with a letter; `<!--` opens a comment; any other
 * `<!`, `<?`, or `</` not followed by a letter is a bogus comment to the next
 * `>`; `</>` is nothing at all.
 */
function scanMarkup(body: string, lt: number): HtmlMarkup | undefined {
  const next = body[lt + 1];
  if (isAsciiLetter(next)) return scanTag(body, lt + 1, false);
  if (next === '/') {
    const after = body[lt + 2];
    if (after === undefined) return;
    if (after === '>') return { end: lt + 3 };
    if (isAsciiLetter(after)) return scanTag(body, lt + 2, true);
    return { end: pastNextGt(body, lt + 2) };
  }
  if (next === '!') {
    if (body.startsWith('--', lt + 2)) return { end: commentEnd(body, lt) };
    return { end: pastNextGt(body, lt + 2) };
  }
  if (next === '?') return { end: pastNextGt(body, lt + 2) };
  return;
}

/**
 * Where a `script` or `style` element's content ends: past the end tag that
 * names it — `</`, the name in any case, then whitespace, `/`, or `>` — which
 * runs to its first `>`. An element never closed runs to the end of the body.
 */
function rawTextEnd(body: string, from: number, name: string): number {
  let at = from;
  for (;;) {
    const close = body.indexOf('</', at);
    if (close === -1) return body.length;
    const after = close + 2 + name.length;
    const terminator = body[after];
    if (
      terminator !== undefined &&
      (terminator === '>' || terminator === '/' || isHtmlWhitespace(terminator)) &&
      matchesAsciiName(body, close + 2, name)
    ) {
      return pastNextGt(body, after);
    }
    at = close + 2;
  }
}

/** Where {@link HtmlLayout} puts the `html` reading, piece by piece, in order. */
export interface HtmlTextSink {
  /** The reading's next characters: `source[from, to)`. */
  append(source: string, from: number, to: number): void;
}

/** Whether `source[from, to)` holds a character that is not whitespace. */
function holdsText(source: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    if (!isWhitespace(source[k] as string)) return true;
  }
  return false;
}

/**
 * The `html` reading's layout, which both readers feed in document order:
 * text, ASCII whitespace, and tag roles in; the reading out, through a sink.
 * Separators are owed between pieces of text and written only once more text
 * follows, so nothing leads or trails the document, and the strongest one
 * owed wins: a blank line over a line break over tabs over a space.
 *
 * A table that opens in a cell before any of the cell's text (whitespace,
 * U+00A0 included, is not text) is the cell's content until its own
 * `</table>`, the way CRS reports wrap a figure to align it: its table and row
 * tags are block breaks inside the cell (a space), its cell tags add nothing,
 * and tables opened inside it are part of it. A table that opens after text in
 * its cell lays out as any table does. That takes a flag and a counter, never
 * an element stack.
 */
export class HtmlLayout {
  /** Whether the open cell has written anything but whitespace. */
  private cellHasText = false;
  /** Tables open as a cell's content: the one that opened the cell and those inside it. */
  private contentTables = 0;
  private inCell = false;
  private newlines = 0;
  private readonly sink: HtmlTextSink;
  private space = false;
  private started = false;
  private tabs = 0;

  constructor(sink: HtmlTextSink) {
    this.sink = sink;
  }

  /** Decoded text: each run of ASCII whitespace separates, everything else is written. */
  text(decoded: string): void {
    let i = 0;
    while (i < decoded.length) {
      if (isHtmlWhitespace(decoded[i] as string)) {
        this.space = true;
        i++;
        continue;
      }
      let end = i + 1;
      while (end < decoded.length && !isHtmlWhitespace(decoded[end] as string)) end++;
      this.write(decoded, i, end);
      i = end;
    }
  }

  /** ASCII whitespace: a space is owed before the next text. */
  whitespace(): void {
    this.space = true;
  }

  /** Write `source[from, to)`, which holds no ASCII whitespace, after whatever separator is owed. */
  write(source: string, from: number, to: number): void {
    if (this.started) {
      if (this.newlines > 0 || this.tabs > 0) {
        const separator = '\n'.repeat(this.newlines) + '\t'.repeat(this.tabs);
        this.sink.append(separator, 0, separator.length);
      } else if (this.space) {
        this.sink.append(' ', 0, 1);
      }
    }
    this.sink.append(source, from, to);
    this.started = true;
    this.newlines = 0;
    this.tabs = 0;
    this.space = false;
    if (this.inCell && !this.cellHasText) this.cellHasText = holdsText(source, from, to);
  }

  tag(role: HtmlTagRole, isEnd: boolean): void {
    if (this.contentTables > 0) {
      if (role === 'table') this.contentTables += isEnd ? -1 : 1;
      if (role !== 'cell' && role !== 'raw') this.space = true;
      return;
    }
    switch (role) {
      case 'cell':
        /** A cell opened inside another closed it: the end tag was omitted. */
        if (isEnd || this.inCell) this.tabs++;
        this.inCell = !isEnd;
        this.cellHasText = false;
        return;
      case 'row':
        this.inCell = false;
        this.lineBreak(1);
        return;
      case 'table':
        if (!isEnd && this.inCell && !this.cellHasText) {
          this.contentTables = 1;
          this.space = true;
          return;
        }
        this.inCell = false;
        this.lineBreak(2);
        return;
      case 'line':
        if (this.inCell) this.space = true;
        else this.lineBreak(1);
        return;
      case 'paragraph':
        if (this.inCell) this.space = true;
        else this.lineBreak(2);
        return;
      case 'raw':
        return;
    }
  }

  /** Tabs still owed when a line break arrives trail the row it ends, so they go. */
  private lineBreak(newlines: number): void {
    this.newlines = Math.max(this.newlines, newlines);
    this.tabs = 0;
  }
}

/**
 * Extract the readable plain text of an HTML page — the `html` reading.
 *
 * Markup is tokenized as the HTML tokenizer reads it, with one simplification:
 * a tag runs from `<` to its first `>`, quoted attribute values included. A `<`
 * opens a tag only before a letter, `/`, `!`, or `?`; otherwise it is text.
 * Comments, declarations, and every tag and attribute are dropped, and so are
 * `script` and `style` with their content; markup left open at the end of the
 * body runs to the end. Character references decode once, within one run of
 * text — never across markup — through the shared decoder.
 *
 * The text is laid out the way a browser shows it, as plain text: each run of
 * ASCII whitespace collapses to one space, {@link HTML_TAG_ROLES} puts line
 * breaks and blank lines between blocks, a table row is one line of trimmed
 * cells joined by tabs (a table that opens a cell is part of that cell), and
 * no line starts or ends with a space. There is no element stack: the state
 * {@link HtmlLayout} keeps across tags is whether a table cell is open,
 * whether it holds text yet, and a count of the tables that are a cell's
 * content, so nesting depth costs nothing.
 */
export function extractHtmlText(body: string): string {
  const parts: string[] = [];
  const layout = new HtmlLayout({
    append: (source, from, to) => {
      parts.push(source.slice(from, to));
    },
  });
  let runStart = 0;
  let at = 0;
  for (;;) {
    const lt = body.indexOf('<', at);
    if (lt === -1) break;
    const markup = scanMarkup(body, lt);
    if (markup === undefined) {
      at = lt + 1;
      continue;
    }
    layout.text(decodeCharacterReferences(body.slice(runStart, lt)));
    at = markup.end;
    if (markup.tag !== undefined) {
      const role = HTML_TAG_ROLES.get(markup.tag.name);
      if (role === 'raw' && !markup.tag.isEnd) at = rawTextEnd(body, at, markup.tag.name);
      else if (role !== undefined) layout.tag(role, markup.tag.isEnd);
    }
    runStart = at;
  }
  layout.text(decodeCharacterReferences(body.slice(runStart)));
  return parts.join('');
}

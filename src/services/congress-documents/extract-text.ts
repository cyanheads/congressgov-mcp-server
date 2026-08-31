/**
 * @fileoverview Turn a Congress.gov document body into the plain text offsets index into.
 * @module services/congress-documents/extract-text
 */

/** Entities GPO emits by name. Numeric references are decoded generically. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]*>/g;
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;
const XML_ELEMENT_BOUNDARY_RE =
  /(?<!<)((?:<\s*\/\s*[a-zA-Z][^>]*>)+)(?=<\s*([a-zA-Z][\w:.-]*)(?:\s|\/?>))/g;
const XML_CLOSE_TAG_RE = /<\s*\/\s*([a-zA-Z][\w:.-]*)[^>]*>/g;
const XML_BOUNDARY_MARKER = '\0';
const INLINE_XML_TAGS = new Set(['a', 'b', 'em', 'i', 'span', 'strong', 'sub', 'sup']);

/**
 * Resolve the body of one character reference — what sits between `&` and `;`.
 * Returns `undefined` for a reference this extractor does not recognize, which
 * the callers render verbatim rather than guessing at.
 */
export function decodeCharacterReference(ref: string): string | undefined {
  if (ref.startsWith('#')) {
    const hex = ref[1] === 'x' || ref[1] === 'X';
    const codePoint = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
    return String.fromCodePoint(codePoint);
  }
  return NAMED_ENTITIES[ref.toLowerCase()];
}

/**
 * Decode HTML/XML character references in one pass.
 *
 * A single pass is the point: decoding `&amp;` in its own sweep would turn the
 * literal `&amp;lt;` into `<` instead of the `&lt;` the document actually says.
 * An unrecognized reference is left verbatim rather than guessed at.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, ref: string) => decodeCharacterReference(ref) ?? match);
}

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
  if (pre !== undefined) return decodeEntities(pre.replace(TAG_RE, '')).trim();
  const readable = decodeEntities(normalizeXmlSiblingBoundaries(stripped).replace(TAG_RE, ''));
  return resolveXmlSiblingBoundaries(readable).trim();
}

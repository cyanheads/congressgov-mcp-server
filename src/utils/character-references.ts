/**
 * @fileoverview Single-pass HTML/XML character-reference decoding — the one
 * decoder every path that turns upstream markup into text runs through: the
 * `content[]` Markdown renderers, the search mirror's plain-text index, and both
 * document text extractors.
 * @module utils/character-references
 */

/**
 * Named references Congress.gov and GPO emit. Numeric references decode
 * generically. `&nbsp;` is the real U+00A0 — renderers that treat it as ordinary
 * spacing fold it into their own whitespace handling.
 */
const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

const CHARACTER_REFERENCE_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/**
 * Resolve the body of one character reference — what sits between `&` and `;`.
 *
 * Returns `undefined` for a reference this decoder does not recognize, which
 * callers render verbatim rather than guessing at. That includes a numeric
 * reference to a code point no string can carry as text: U+0000 (excluded from
 * XML's character set, and the document extractor's internal boundary marker),
 * a surrogate (half of a UTF-16 pair, never a character on its own), or anything
 * past U+10FFFF.
 */
export function decodeCharacterReference(ref: string): string | undefined {
  if (ref.startsWith('#')) {
    const hex = ref[1] === 'x' || ref[1] === 'X';
    const codePoint = Number.parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
    if (
      !Number.isInteger(codePoint) ||
      codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return;
    }
    return String.fromCodePoint(codePoint);
  }
  return NAMED_REFERENCES[ref.toLowerCase()];
}

/**
 * Decode every character reference in `text` in one pass.
 *
 * A single pass is the point: decoding `&amp;` in a sweep of its own, before or
 * after the others, turns the literal `&amp;lt;` into `<` instead of the `&lt;`
 * the text actually says. An unrecognized reference is left verbatim.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(
    CHARACTER_REFERENCE_RE,
    (match, ref: string) => decodeCharacterReference(ref) ?? match,
  );
}

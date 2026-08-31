/**
 * @fileoverview Differential tests for the incremental document text extractor.
 *
 * The character offsets in the `content` contract are defined against
 * `extractDocumentText`, so the incremental form is only correct if it produces
 * byte-identical output for the same input. Every case here compares the two
 * directly, across chunk splittings that cut markup, entities, and comments in
 * half, rather than asserting hand-written expectations twice.
 * @module tests/services/congress-documents/extract-text-stream.test
 */

import { describe, expect, it } from 'vitest';
import { extractDocumentText } from '@/services/congress-documents/extract-text.js';
import { createStreamingExtractor } from '@/services/congress-documents/extract-text-stream.js';

/** Run the incremental extractor over `body` split into `size`-character chunks. */
function runIncremental(
  body: string,
  size: number,
  characterOffset = 0,
  characterLimit = Number.MAX_SAFE_INTEGER,
): { text: string; totalCharacters: number } {
  const extractor = createStreamingExtractor({ characterOffset, characterLimit });
  for (let i = 0; i < body.length; i += size) extractor.push(body.slice(i, i + size));
  return extractor.finish();
}

/** Chunk sizes chosen to split multi-character constructs at every position. */
const CHUNK_SIZES = [1, 2, 3, 4, 5, 7, 13, 64, 1024, Number.MAX_SAFE_INTEGER];

/** Assert the incremental extractor matches the whole-string one for every chunking. */
function expectIdentical(body: string): void {
  const reference = extractDocumentText(body);
  for (const size of CHUNK_SIZES) {
    const result = runIncremental(body, size);
    expect(result.text, `chunk size ${size}`).toBe(reference);
    expect(result.totalCharacters, `chunk size ${size}`).toBe(reference.length);
  }
}

/**
 * The shapes www.congress.gov serves plus the malformed-markup cases where the
 * pipeline's stage order is observable. Kept in step with the pinned cases in
 * `extract-text.test.ts`.
 */
const CORPUS: Record<string, string> = {
  gpoFormattedText: '<html><body><pre>\n[Congressional Bills]\nSEC. 1.\n</pre></body></html>\n',
  formattedXml:
    '<?xml version="1.0"?>\n<!DOCTYPE bill PUBLIC "x" "bill.dtd">\n<bill><text>Sec. 1.</text></bill> \n\n',
  bareText: 'plain text document',
  preWithTail: '<pre>a</pre>tail',
  preEmptyThenTail: '<pre></pre>tail',
  severalPreBlocks: '<pre>a</pre>mid<pre>b</pre>',
  closeBeforeOpen: '</pre><pre>body',
  spacedPreTags: '< pre >x< / PRE >tail',
  selfClosingPre: '<pre/>body',
  preInsideAttribute: '<a href="<pre>">after',
  unterminatedComment: '<pre>a<!--b</pre>',
  unterminatedCommentWithGt: 'head<!--tail with > inside',
  unterminatedTag: '<pre>a<b</pre>',
  unterminatedTagAtEnd: 'alpha<beta',
  nestedCommentOpen: '<!--a<!--b-->c',
  preInsideComment: '<!--<pre>--><b>text</b>',
  entityAcrossTag: '<pre>&am<i>p;</pre>',
  entityAcrossComment: '&am<!--x-->p;',
  entityRestart: '&&amp;',
  entityPartialRestart: '&am&amp;',
  leadingZeroReference: '&#0000065;',
  hexReferences: '&#x41;&#X42;',
  surrogateReference: '&#128512;x',
  unresolvableReferences: '&abcdefghij; &#99999999; &#; &#x; &notarealentity;',
  paddedOverflowReference: `&#${'0'.repeat(40)}65; &#${'9'.repeat(40)};`,
  bareAngleBrackets: 'a > b < c',
  trailingWhitespace: '<pre>a   \n\n</pre>',
  trailingNbsp: '<pre>a&nbsp;</pre>',
  whitespaceOnly: '<pre>   \n  </pre>',
  empty: '',
  carriageReturns: '<pre>alpha\r\nbeta\rgamma\r</pre>',
  crlfSplitAcrossEverything: 'a\r\r\n\r\nb\r',
  commentSpanningPre: '<pre>one<!--two</pre>three-->four</pre>five',
  entityIntoTrailingTrim: '<pre>body&#32;&#32;</pre>',
  tagOnlyDocument: '<html><body></body></html>',
  siblingXml:
    '<bill><ordinal>II</ordinal><congress>119th CONGRESS</congress><session>2d Session</session><number>S. 4809</number><heading>IN THE SENATE</heading><date>June 17, 2026</date></bill>',
  nestedSiblingXml:
    '<bill><section><label>SEC. 1.</label><heading>SHORT TITLE</heading><text>pre<em>formatted</em>text &amp; more</text></section><!-- split --><section><label>SEC. 2.</label><text>Second.\r\nLine two.</text></section></bill>',
  ancestorWhitespaceXml: '<outer><a>one</a>&#32;</outer><b>two</b>',
  followingWhitespaceXml: '<outer><a>one</a></outer><b>&nbsp;two</b>',
  adjacentInlineXml:
    '<root>pre<em>form</em><strong>atted</strong><span>text</span><sub>2</sub><sup>x</sup></root>',
  entityAcrossInlineTags: '<root>&am</i><b>p;</b></root>',
};

describe('createStreamingExtractor', () => {
  describe('matches the whole-string extractor', () => {
    for (const [name, body] of Object.entries(CORPUS)) {
      it(name, () => {
        expectIdentical(body);
      });
    }
  });

  describe('character window', () => {
    const body = CORPUS.gpoFormattedText as string;
    const reference = extractDocumentText(body);

    it('returns the slice the whole-string extractor would return', () => {
      for (let offset = 0; offset <= reference.length + 2; offset++) {
        for (const limit of [1, 3, 10, reference.length, reference.length + 50]) {
          const result = runIncremental(body, 5, offset, limit);
          expect(result.text, `offset ${offset} limit ${limit}`).toBe(
            reference.slice(offset, offset + limit),
          );
          expect(result.totalCharacters).toBe(reference.length);
        }
      }
    });

    it('reports totalCharacters even when the window is empty', () => {
      const result = runIncremental(body, 7, reference.length + 100, 25);
      expect(result.text).toBe('');
      expect(result.totalCharacters).toBe(reference.length);
    });

    it('excludes trailing whitespace the trim removes from the last window', () => {
      const padded = '<pre>alpha        </pre>';
      const trimmed = extractDocumentText(padded);
      const result = runIncremental(padded, 3, 0, 1000);
      expect(result.text).toBe(trimmed);
      expect(result.text).toBe('alpha');
      expect(result.totalCharacters).toBe(5);
    });

    it('walks corrected nested XML windows and reassembles the exact text', () => {
      const xml = CORPUS.nestedSiblingXml as string;
      const expected = extractDocumentText(xml);
      expect(expected).toBe(
        'SEC. 1. SHORT TITLE preformattedtext & more SEC. 2. Second.\nLine two.',
      );

      for (const size of [1, 2, 5, 11, 64]) {
        const windows: string[] = [];
        let offset = 0;
        while (offset < expected.length) {
          const page = runIncremental(xml, size, offset, 13);
          expect(page.totalCharacters, `chunk size ${size}`).toBe(expected.length);
          expect(page.text, `chunk size ${size} offset ${offset}`).toBe(
            expected.slice(offset, offset + 13),
          );
          windows.push(page.text);
          offset += page.text.length;
        }
        expect(windows.join(''), `chunk size ${size}`).toBe(expected);
      }
    });
  });

  describe('randomized bodies', () => {
    /** Deterministic PRNG — a failing seed is reproducible. */
    function makeRandom(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
    }

    const TOKENS = [
      '<pre>',
      '</pre>',
      '<PRE class="x">',
      '< / pre >',
      '<pre/>',
      '<!--',
      '-->',
      '<b>',
      '</b>',
      '<em>',
      '</em>',
      '<section>',
      '</section>',
      '<',
      '>',
      '&',
      ';',
      '#',
      'amp',
      'lt',
      '&amp;',
      '&#65;',
      '&#32;',
      '&#x2014;',
      '&nbsp;',
      '&nope;',
      ' ',
      '\n',
      '\r\n',
      '\r',
      ' ',
      'SEC. 1.',
      'text',
      '"',
      '/',
      'p',
      'r',
      'e',
    ];

    it('matches on 400 random token soups across random chunkings', () => {
      const random = makeRandom(0x5eed);
      for (let trial = 0; trial < 400; trial++) {
        const length = 1 + Math.floor(random() * 60);
        let body = '';
        for (let i = 0; i < length; i++) {
          body += TOKENS[Math.floor(random() * TOKENS.length)];
        }
        const reference = extractDocumentText(body);
        const size = 1 + Math.floor(random() * 20);
        const offset = Math.floor(random() * (reference.length + 3));
        const limit = 1 + Math.floor(random() * (reference.length + 3));
        const result = runIncremental(body, size, offset, limit);
        const label = `trial ${trial} size ${size} offset ${offset} limit ${limit}: ${JSON.stringify(body)}`;
        expect(result.totalCharacters, label).toBe(reference.length);
        expect(result.text, label).toBe(reference.slice(offset, offset + limit));
      }
    });
  });

  describe('multi-megabyte documents', () => {
    /**
     * These cases re-stream a multi-megabyte body dozens of times, which runs
     * several seconds and has no headroom under Vitest's 5s default when the
     * suite is running files in parallel.
     */
    const MULTI_MB_TIMEOUT_MS = 30_000;

    /** A GPO Formatted Text body several megabytes past the old 5 MB ceiling. */
    function buildBill(sections: number): string {
      const parts: string[] = ['<html><body><pre>\n[Congressional Bills 116th Congress]\n'];
      for (let i = 1; i <= sections; i++) {
        parts.push(
          `\nSEC. ${i}. SHORT TITLE OF SECTION ${i}.\n\n    In this section, the term \`\`covered'' means an amount &lt;= $${i},000 &amp; not more.\n    Paragraph body for section ${i}, padded to a realistic line width for GPO output.\n`,
        );
      }
      parts.push('</pre></body></html>\n');
      return parts.join('');
    }

    const body = buildBill(24_000);
    const reference = extractDocumentText(body);

    it('is larger than the old 5,000,000-byte ceiling', () => {
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(5_000_000);
    });

    it(
      'matches the whole-string extractor at the start, middle, and end',
      () => {
        const windows = [
          { characterOffset: 0, characterLimit: 100_000 },
          { characterOffset: Math.floor(reference.length / 2), characterLimit: 100_000 },
          { characterOffset: reference.length - 100, characterLimit: 100_000 },
        ];
        for (const window of windows) {
          const extractor = createStreamingExtractor(window);
          for (let i = 0; i < body.length; i += 65_536) extractor.push(body.slice(i, i + 65_536));
          const result = extractor.finish();
          expect(result.totalCharacters, JSON.stringify(window)).toBe(reference.length);
          expect(result.text, JSON.stringify(window)).toBe(
            reference.slice(window.characterOffset, window.characterOffset + window.characterLimit),
          );
        }
      },
      MULTI_MB_TIMEOUT_MS,
    );

    it(
      'reassembles exactly when walked window by window',
      () => {
        const limit = 100_000;
        const chunks: string[] = [];
        let offset = 0;
        while (offset < reference.length) {
          const extractor = createStreamingExtractor({
            characterOffset: offset,
            characterLimit: limit,
          });
          for (let i = 0; i < body.length; i += 262_144) extractor.push(body.slice(i, i + 262_144));
          const page = extractor.finish();
          expect(page.totalCharacters).toBe(reference.length);
          expect(page.text.length).toBeGreaterThan(0);
          chunks.push(page.text);
          offset += page.text.length;
        }
        expect(chunks.join('')).toBe(reference);
        expect(chunks.length).toBeGreaterThan(1);
      },
      MULTI_MB_TIMEOUT_MS,
    );
  });
});

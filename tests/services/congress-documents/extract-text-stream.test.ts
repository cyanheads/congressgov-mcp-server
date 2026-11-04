/**
 * @fileoverview Differential tests for the incremental document text extractor.
 *
 * The character offsets in the `content` contract are defined against
 * `extractDocumentText` (the `gpo` reading) and `extractHtmlText` (the `html`
 * reading), so the incremental form is only correct if it produces
 * byte-identical output for the same input. Every case here compares the two
 * directly, across chunk splittings that cut markup, entities, and comments in
 * half, rather than asserting hand-written expectations twice.
 * @module tests/services/congress-documents/extract-text-stream.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractDocumentText,
  extractHtmlText,
} from '@/services/congress-documents/extract-text.js';
import { createStreamingExtractor } from '@/services/congress-documents/extract-text-stream.js';

/** Run the incremental extractor over `body` split into `size`-character chunks. */
function runIncremental(
  body: string,
  size: number,
  characterOffset = 0,
  characterLimit = Number.MAX_SAFE_INTEGER,
): { text: string; totalCharacters: number } {
  const extractor = createStreamingExtractor({ characterOffset, characterLimit, reading: 'gpo' });
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
  nulReferenceXml: '<root>x&#0;y</root><b>&#x0000;z</b>',
  loneSurrogateReferences: '<pre>a&#xD800;b&#57343;c&#x0DBFF;</pre>',
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
          const extractor = createStreamingExtractor({ ...window, reading: 'gpo' });
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

    it.each(Array.from({ length: Math.ceil(reference.length / 100_000) }, (_, i) => i * 100_000))(
      'matches the complete document window at %i',
      (offset) => {
        const page = runIncremental(body, 262_144, offset, 100_000);
        expect(page.totalCharacters).toBe(reference.length);
        expect(page.text).toBe(reference.slice(offset, offset + 100_000));
      },
    );
  });

  describe('reading selection', () => {
    it('reads a body the gpo way when the caller names gpo', () => {
      for (const body of Object.values(CORPUS)) {
        const explicit = createStreamingExtractor({
          characterOffset: 0,
          characterLimit: Number.MAX_SAFE_INTEGER,
          reading: 'gpo',
        });
        explicit.push(body);
        expect(explicit.finish().text, JSON.stringify(body)).toBe(extractDocumentText(body));
      }
    });

    it('never picks the reading from the body', () => {
      const body = '<p>alpha</p><pre>beta</pre><script>gamma</script>';
      const gpo = createStreamingExtractor({
        characterOffset: 0,
        characterLimit: 100,
        reading: 'gpo',
      });
      gpo.push(body);
      expect(gpo.finish().text).toBe('beta');
      const html = createStreamingExtractor({
        characterOffset: 0,
        characterLimit: 100,
        reading: 'html',
      });
      html.push(body);
      expect(html.finish().text).toBe('alpha\n\nbeta');
    });
  });
});

/** Run the `html` reading over `body` split into `size`-character chunks. */
function runHtml(
  body: string,
  size: number,
  characterOffset = 0,
  characterLimit = Number.MAX_SAFE_INTEGER,
): { text: string; totalCharacters: number } {
  const extractor = createStreamingExtractor({ characterOffset, characterLimit, reading: 'html' });
  for (let i = 0; i < body.length; i += size) extractor.push(body.slice(i, i + size));
  return extractor.finish();
}

/** Run the `html` reading over `body` cut into two chunks at `at`. */
function runHtmlSplit(body: string, at: number): { text: string; totalCharacters: number } {
  const extractor = createStreamingExtractor({
    characterOffset: 0,
    characterLimit: Number.MAX_SAFE_INTEGER,
    reading: 'html',
  });
  extractor.push(body.slice(0, at));
  extractor.push(body.slice(at));
  return extractor.finish();
}

/** The acceptance shapes: each body with the text both readers must produce. */
const HTML_ACCEPTANCE: ReadonlyArray<readonly [string, string]> = [
  ['<!-- <script>x</script> -->a', 'a'],
  ['<script>x</script >b', 'b'],
  ['<SCRIPT>x</script\n>c', 'c'],
  ['<scr<b>ipt>x</scr<b>ipt>y', 'ipt>xipt>y'],
  ['<![CDATA[x<y]]>z', 'z'],
  ['<table><tr><td><p>a</p><p>b</p></td><td>c</td></tr></table>', 'a b\tc'],
];

/**
 * Shapes where the tokenizer's state is observable across a chunk boundary.
 * Kept in step with the `extractHtmlText` cases in `extract-text.test.ts`.
 */
const HTML_CORPUS: Record<string, string> = {
  crsReportHead:
    '<head><meta charset="utf-8"/></head>\n    &lt;%@ Control Language="C#" ClassName="CRSgov.UI.Product" %&gt;\n    <script language="C#" runat="server" xmlns:ns1="http://schemas.crs.loc.gov/ap/metadata">\n      public string REPORT_HTML_LOCATION = System.Configuration.ConfigurationSettings.AppSettings["REPORT_HTML_LOCATION"];\n    </script><div class="Report"><div class="HeaderLinks">\n<div></div>\n</div>\n<div class="Title">Voter Registration: Recent Developments</div>\n<div class="CoverDate">Updated October 30, 2026\n            (R46406)\n          <br/><a href="#Content">Jump to Main Text of Report</a></div>\n<hr color="#003399"/>\n<h1>Contents</h1>\n<ul><li class="TOC1"><a href="#_Toc1"><span class="Hyperlink">Introduction</span></a></li>\n<li class="TOC2"><a href="#_Toc2">NVRA</a></li></ul>',
  crsChartScript:
    '<p class="BodyText">Before.</p><script type="text/javascript">\nHighcharts.theme = { colors: ["#1f77b4"], title: { text: "<b>a</b> & </scrip" } };\nif (a < b && c > d) { document.write("<\\/script>"); }\n</script><p class="BodyText">After &amp; more.</p>',
  crsFootnotes:
    '<h1>Footnotes</h1>\n<table border="0" cellpadding="0" cellspacing="5">\n<tr>\n<td valign="top"><a class="FootnoteBL" href="#ifn1" name="fn1">1</a>.\n            </td>\n<td>\n<p class="FootnoteText" style=""> See <a class="ExternalLink" href="http://www.crs.gov/Reports/RL33153"><em><span class="Hyperlink">China Naval Modernization</span></em></a>, by Ronald O\'Rourke.</p>\n</td>\n</tr>\n<tr><td>2</td><td><p>Second&#160;note.</p></td></tr>\n</table>',
  crsDataGrid:
    '<p class="Figure"><table class="ReportTable"><tr style=""><td><p class="TableTextHeading">Year</p></td><td><p class="TableTextHeading">OASI</p></td><td></td></tr>\n<tr><td></td><td><p>1.2</p><p>(est.)</p></td><td>3</td></tr></table></p>',
  scriptVariants:
    'a<script>1</script>b<SCRIPT >2</SCRIPT\t>c<script/>3</script/>d<style>4</style >e<script>5</scriptx>6</script>f',
  rawElementMismatch: '<script>a</style>b</script>c<style>d</script>e</STYLE/>f',
  unclosedScript: 'a<script>b</scrip',
  unclosedScriptEndTag: 'a<script>b</script ',
  unclosedStyle: 'a<style>b',
  comments: '<!-->a<!--->b<!---->c<!-- x --!>d<!-- x <!-- y -->e<!---x-->f',
  unclosedCommentBang: '<!--!>a<!---!>b',
  unclosedComment: 'a<!-- b <p>c</p>',
  bogusMarkup: '<!DOCTYPE html>a<?xml version="1.0"?>b<!>c<!->d<!-x>e</>f</ x>g</3>h',
  cdata: '<![CDATA[x<y]]>z<![CDATA[a>b]]>c',
  unterminatedTag: 'alpha<beta gamma',
  unterminatedEndTag: 'alpha</beta',
  unterminatedBogus: 'alpha<!DOCTYPE',
  unterminatedMarkupOpen: 'alpha<!',
  textAngles: 'a < b <3 c<= d<',
  textEndTagOpen: 'x</',
  loneAngle: '<',
  quotedGreaterThan: '<a title="x>y">z</a>',
  nestedTagName: '<a<b<c>d>e',
  whitespaceRuns: '  a \n\t b\r\n\fc  \r',
  onlyWhitespace: ' \n\t \r\n ',
  empty: '',
  nbsp: '&nbsp;a&nbsp;&#160; b ',
  decodedWhitespace: 'a&#32; &#10;&#x9;b&#13;c',
  references: '&amp;lt; &lt;b&gt; &quot;q&quot; &#x2014; &#8212; &#128512;',
  decodedMarkup: '&lt;script&gt;x&lt;/script&gt;y',
  unresolvable: '&copy; &#0; &#xD800; &#99999999; &#; &#x; &abcdefghij; &',
  paddedReferences: `&#${'0'.repeat(40)}65; &#${'9'.repeat(40)}; &#x${'0'.repeat(30)}41;`,
  referenceAcrossMarkup: '&am<i>p; &am<!-- x -->p; &am<script>x</script>p;',
  referenceRestart: '&&amp; &am&amp; &#0000065;',
  referenceIntoTag: '&amp<p>; &#65<br>; &#x<b>41;',
  referenceIntoTextAngle: '&lt< &#6< b;',
  blocks:
    '<h1>Contents</h1><ul><li>a</li><li>b</li></ul>after<h2>x</h2><ol><li>y</li></ol><blockquote>z</blockquote>w<hr>v',
  lines: '<div>a</div><div>b</div>c<br/>d<BR>e</br>f<li>g',
  blankLines: '<p>a</p><p></p>\n<p> </p><br><div></div><p>b</p>',
  trimmedLines: '<p>  a  </p>  <p>\n b \n</p>a <br> b',
  inline: '<p>pre<em>formatted</em> <strong>text</strong><span class="Hyperlink">!</span></p>',
  tableRows:
    '<p>Table 1</p><table><tr><th>Year</th><th>OASI</th></tr>\n<tr>\n<td> 2026 </td>\n<td>$1,234</td>\n</tr></table><p>Source</p>',
  blocksInCell:
    '<table><tr><td><div>a</div><br>b<ul><li>c</li></ul><hr>d</td><td>e</td></tr></table>',
  emptyCells:
    '<table><tr><td>a</td><td></td><td>c</td></tr><tr><td></td><td>e</td><td></td></tr><tr><td>g</td></tr></table>',
  omittedCellEnd: '<table><tr><td>a<td>b<tr><td>c</table>',
  nestedTable:
    '<table><tr><td>x<table><tr><td>a</td><td>b</td></tr></table>y</td><td>z</td></tr></table>',
  longTagName: '<blockquotes>a</blockquotes>b<blockquote>c<scripts>d</scripts>e<tdx>f',
  surrogates: '𝔄 a\ud800b',
};

describe('createStreamingExtractor — html reading', () => {
  describe('acceptance shapes', () => {
    it.each(HTML_ACCEPTANCE)('reads %j at every split', (body, expected) => {
      expect(extractHtmlText(body)).toBe(expected);
      for (let at = 0; at <= body.length; at++) {
        const result = runHtmlSplit(body, at);
        expect(result.text, `split at ${at}`).toBe(expected);
        expect(result.totalCharacters, `split at ${at}`).toBe(expected.length);
      }
      for (const size of CHUNK_SIZES) {
        expect(runHtml(body, size).text, `chunk size ${size}`).toBe(expected);
      }
    });
  });

  describe('matches the whole-string reading', () => {
    for (const [name, body] of Object.entries(HTML_CORPUS)) {
      it(name, () => {
        const reference = extractHtmlText(body);
        for (const size of CHUNK_SIZES) {
          const result = runHtml(body, size);
          expect(result.text, `chunk size ${size}`).toBe(reference);
          expect(result.totalCharacters, `chunk size ${size}`).toBe(reference.length);
        }
        for (let at = 0; at <= body.length; at++) {
          expect(runHtmlSplit(body, at).text, `split at ${at}`).toBe(reference);
        }
      });
    }
  });

  describe('character window', () => {
    const body = (HTML_CORPUS.crsReportHead as string) + (HTML_CORPUS.crsFootnotes as string);
    const reference = extractHtmlText(body);

    it('returns the slice the whole-string reading would return', () => {
      expect(reference.length).toBeGreaterThan(100);
      for (let offset = 0; offset <= reference.length + 2; offset++) {
        for (const limit of [1, 3, 10, reference.length, reference.length + 50]) {
          const result = runHtml(body, 7, offset, limit);
          expect(result.text, `offset ${offset} limit ${limit}`).toBe(
            reference.slice(offset, offset + limit),
          );
          expect(result.totalCharacters).toBe(reference.length);
        }
      }
    });

    it('reports totalCharacters even when the window is empty', () => {
      const result = runHtml(body, 5, reference.length + 100, 25);
      expect(result.text).toBe('');
      expect(result.totalCharacters).toBe(reference.length);
    });

    it('never counts separators that no later text follows', () => {
      const trailing = '<p>alpha</p>\n<table><tr><td></td><td></td></tr></table><br>  ';
      expect(runHtml(trailing, 3, 0, 1000)).toEqual({ text: 'alpha', totalCharacters: 5 });
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
      '<',
      '>',
      '/',
      '!',
      '?',
      '-',
      '--',
      '<!--',
      '-->',
      '--!>',
      '<!',
      '<!-',
      '<?',
      '</',
      '<p>',
      '</p>',
      '<P class="x">',
      '<br/>',
      '<div>',
      '</div>',
      '<li>',
      '<ul>',
      '</ul>',
      '<table>',
      '</table>',
      '<tr>',
      '</tr>',
      '<td>',
      '</td>',
      '<th>',
      '</th>',
      '<h1>',
      '<hr>',
      '<b>',
      '<script>',
      '</script>',
      '</script ',
      '</SCRIPT\n',
      '<style>',
      '</style>',
      'script',
      'style',
      '<scr',
      'ipt>',
      '<![CDATA[',
      ']]>',
      '&',
      ';',
      '#',
      'x',
      'amp',
      'lt',
      '&amp;',
      '&lt;',
      '&#65;',
      '&#32;',
      '&#10;',
      '&#x2014;',
      '&nbsp;',
      '&nope;',
      '&#0;',
      ' ',
      '\n',
      '\r\n',
      '\t',
      '\f',
      'a',
      'text',
      '"',
      "'",
      '=',
      ' ',
    ];

    it('matches on 800 random token soups across random chunkings and windows', () => {
      const random = makeRandom(0x417e1);
      for (let trial = 0; trial < 800; trial++) {
        const length = 1 + Math.floor(random() * 60);
        let body = '';
        for (let i = 0; i < length; i++) {
          body += TOKENS[Math.floor(random() * TOKENS.length)];
        }
        const reference = extractHtmlText(body);
        const size = 1 + Math.floor(random() * 20);
        const offset = Math.floor(random() * (reference.length + 3));
        const limit = 1 + Math.floor(random() * (reference.length + 3));
        const result = runHtml(body, size, offset, limit);
        const label = `trial ${trial} size ${size} offset ${offset} limit ${limit}: ${JSON.stringify(body)}`;
        expect(result.totalCharacters, label).toBe(reference.length);
        expect(result.text, label).toBe(reference.slice(offset, offset + limit));
      }
    });
  });

  describe('report-sized documents', () => {
    /** A CRS-shaped page of `sections` sections, each with prose, a chart script, and a table. */
    function buildReport(sections: number): string {
      const parts = [HTML_CORPUS.crsReportHead as string];
      for (let i = 1; i <= sections; i++) {
        parts.push(
          `\n<p class="Heading1">Section ${i} &amp; Context</p>\n<p class="BodyText">Body ${i} cites <a href="#fn${i}">P.L. 117-${i}</a><sup><a class="FootnoteLink" title="Note ${i}.">${i}</a></sup>, at &#8220;${i}&#8221;.</p>\n<script type="text/javascript">Highcharts.chart("c${i}", { data: [${i}, ${i + 1}], label: "<p>${i}</p>" });</script>\n<table class="ReportTable"><tr><td><p>Year</p></td><td><p>${2000 + (i % 30)}</p></td></tr></table>`,
        );
      }
      parts.push(HTML_CORPUS.crsFootnotes as string);
      return parts.join('');
    }

    const body = buildReport(1_500);
    const reference = extractHtmlText(body);

    it('carries no script text', () => {
      expect(body.length).toBeGreaterThan(400_000);
      expect(reference).not.toContain('Highcharts');
      expect(reference).not.toContain('REPORT_HTML_LOCATION');
      expect(reference).toContain(
        'Section 1500 & Context\n\nBody 1500 cites P.L. 117-15001500, at “1500”.',
      );
    });

    it('walks every window via nextOffset and reassembles the reading exactly', () => {
      const windows: string[] = [];
      let offset = 0;
      while (offset < reference.length) {
        const page = runHtml(body, 16_384, offset, 25_000);
        expect(page.totalCharacters).toBe(reference.length);
        expect(page.text, `offset ${offset}`).toBe(reference.slice(offset, offset + 25_000));
        windows.push(page.text);
        offset += page.text.length;
      }
      expect(windows.length).toBeGreaterThanOrEqual(5);
      expect(windows.join('')).toBe(reference);
    });
  });
});

/**
 * Both readers make one pass with constant work per character. These time each
 * against the inputs a backtracking or strip-to-fixed-point scanner turns
 * quadratic on, in the thread's own CPU time.
 */
describe('html reading timing', () => {
  /** Least thread CPU time per call, in microseconds, over `rounds` batches of `batch` calls. */
  function leastCpuMicrosPerCall(fn: () => void, batch: number, rounds = 3): number {
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < rounds; round++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) fn();
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / batch);
    }
    return least;
  }

  function streamHtml(body: string): void {
    const extractor = createStreamingExtractor({
      characterOffset: 0,
      characterLimit: 1_000,
      reading: 'html',
    });
    for (let i = 0; i < body.length; i += 16_384) extractor.push(body.slice(i, i + 16_384));
    extractor.finish();
  }

  /** CPU microseconds per character a linear reader stays well inside; a quadratic one at 20k is far outside. */
  const MICROS_PER_CHARACTER = 1;

  /**
   * Doubles from 5k to `maxChars` and times both readers, checking the absolute
   * bound at each size before running the next, so a quadratic regression fails
   * in seconds. Returns each reader's per-call times.
   */
  function timeShape(build: (chars: number) => string, maxChars: number) {
    const whole: number[] = [];
    const stream: number[] = [];
    for (let chars = 5_000; chars <= maxChars; chars *= 2) {
      const body = build(chars);
      /** ~640k characters per batch, so even the cheapest shape's batch spans far more than the timer's 1 µs resolution. */
      const batch = Math.max(1, Math.round(640_000 / body.length));
      const wholeMicros = leastCpuMicrosPerCall(() => extractHtmlText(body), batch);
      expect(wholeMicros, `whole-string, ${body.length} chars`).toBeLessThan(
        body.length * MICROS_PER_CHARACTER,
      );
      const streamMicros = leastCpuMicrosPerCall(() => streamHtml(body), batch);
      expect(streamMicros, `streaming, ${body.length} chars`).toBeLessThan(
        body.length * MICROS_PER_CHARACTER,
      );
      whole.push(wholeMicros);
      stream.push(streamMicros);
    }
    return { whole, stream };
  }

  const ratio = (perCall: number[]) => (perCall.at(-1) as number) / (perCall[0] as number);
  const repeatTo = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /** Shapes that stay below Bun's regex mode switch at every size, so each carries the full 64× span. */
  const FULL_SPAN: ReadonlyArray<readonly [string, (chars: number) => string]> = [
    ['an opener repeated with no closer', (chars) => repeatTo('<a', chars)],
    ['nested openers', (chars) => `${repeatTo('<a', chars / 2)}${repeatTo('>', chars / 2)}`],
    ['a long run of < with no >', (chars) => repeatTo('<', chars)],
    ['an unterminated comment', (chars) => `<!--${repeatTo('x', chars)}`],
    ['an unterminated comment of dashes', (chars) => `<!--${repeatTo('-', chars)}`],
    ['comment closers that never close', (chars) => `<!--${repeatTo('--!', chars)}`],
    ['repeated comment openers', (chars) => repeatTo('<!--', chars)],
    ['an unterminated script', (chars) => `<script>${repeatTo('x<', chars)}`],
    ['overlapping script end prefixes', (chars) => `<script>${repeatTo('</scrip', chars)}`],
    ['repeated script openers', (chars) => repeatTo('<script>', chars)],
    ['repeated bogus openers', (chars) => repeatTo('<!x', chars)],
    ['one long line ending in a break', (chars) => `${repeatTo('<p>x', chars)}\ny`],
    ['breaks throughout', (chars) => repeatTo('  \r\n', chars)],
    ['table cells', (chars) => repeatTo('<td>x</td>', chars)],
    ['a long tag name', (chars) => `<${repeatTo('a', chars)}>b`],
    ['zero-padded references', (chars) => `&#${repeatTo('0', chars)}65;`],
    ['ampersands', (chars) => repeatTo('&', chars)],
    ['ampersand-letter pairs', (chars) => repeatTo('&a', chars)],
    ['references', (chars) => repeatTo('&amp;', chars)],
  ];

  for (const [label, build] of FULL_SPAN) {
    it(`stays linear on ${label} across a 64× span`, () => {
      const { whole, stream } = timeShape(build, 320_000);
      expect(whole).toHaveLength(7);
      expect(ratio(whole), 'whole-string').toBeLessThan(256);
      expect(ratio(stream), 'streaming').toBeLessThan(256);
    }, 60_000);
  }
});

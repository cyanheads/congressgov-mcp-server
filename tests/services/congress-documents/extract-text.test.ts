/**
 * @fileoverview Tests for the whole-string document readings: the GPO `<pre>` /
 * XML reading and the HTML reading. The extracted string is what every
 * character offset indexes into, so these pin exactness: verbatim whitespace,
 * single-pass entity decoding, deterministic newlines, and HTML layout.
 * @module tests/services/congress-documents/extract-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractDocumentText,
  extractHtmlText,
  isWhitespace,
} from '@/services/congress-documents/extract-text.js';

describe('isWhitespace', () => {
  /** The whitespace `String.prototype.trim` removes, which decides what a cell holds before a table (#118). */
  it('agrees with String.prototype.trim on every BMP code unit', () => {
    const disagreements: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      if (isWhitespace(ch) !== (ch.trim() === '')) {
        disagreements.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe('extractDocumentText', () => {
  it('unwraps a bare <pre> body and keeps the print layout verbatim', () => {
    const body = '<pre>\n\n  SEC. 1. SHORT TITLE.\n\n    This Act may be cited as...\n</pre>';
    expect(extractDocumentText(body)).toBe(
      'SEC. 1. SHORT TITLE.\n\n    This Act may be cited as...',
    );
  });

  it('unwraps an <html><body><pre> wrapper', () => {
    const body =
      '<html><body><pre>\n[Congressional Bills 119th Congress]\nline two\n</pre></body></html>';
    expect(extractDocumentText(body)).toBe('[Congressional Bills 119th Congress]\nline two');
  });

  it('keeps interior column alignment and blank lines exactly', () => {
    const body =
      '<pre>Mr. Cole, Chairman..............................          Yea\n\n\n   [all]</pre>';
    expect(extractDocumentText(body)).toBe(
      'Mr. Cole, Chairman..............................          Yea\n\n\n   [all]',
    );
  });

  it('strips inline anchors but keeps their text', () => {
    const body =
      "<pre>From the Congressional Record Online through the GPO [<a href='https://www.gpo.gov'>www.gpo.gov</a>]</pre>";
    expect(extractDocumentText(body)).toBe(
      'From the Congressional Record Online through the GPO [www.gpo.gov]',
    );
  });

  it('decodes named and numeric entities in a single pass', () => {
    const body =
      '<pre>&lt;DOC&gt; the agency&#x27;s plan &amp; more &#8212; &quot;quoted&quot;</pre>';
    expect(extractDocumentText(body)).toBe('<DOC> the agency\'s plan & more — "quoted"');
  });

  it('does not double-decode an escaped entity', () => {
    expect(extractDocumentText('<pre>&amp;lt;not-a-tag&amp;gt;</pre>')).toBe('&lt;not-a-tag&gt;');
  });

  it('leaves an unknown entity untouched rather than guessing', () => {
    expect(extractDocumentText('<pre>a &notarealentity; b</pre>')).toBe('a &notarealentity; b');
  });

  it('normalizes CRLF and lone CR to LF so offsets are platform-stable', () => {
    expect(extractDocumentText('<pre>alpha\r\nbeta\rgamma</pre>')).toBe('alpha\nbeta\ngamma');
  });

  it('strips XML declarations, comments, and tags for an XML body', () => {
    const body =
      '<?xml version="1.0"?><!--Disclaimer: not legal\ntext > here--><bill><section>Sec. 1. </section>\n<text>Rescission of amounts.</text></bill>';
    expect(extractDocumentText(body)).toBe('Sec. 1. \nRescission of amounts.');
  });

  it('separates adjacent sibling XML elements', () => {
    const body =
      '<bill><ordinal>II</ordinal><congress>119th CONGRESS</congress><session>2d Session</session><number>S. 4809</number><heading>IN THE SENATE</heading><date>June 17, 2026</date></bill>';
    expect(extractDocumentText(body)).toBe(
      'II 119th CONGRESS 2d Session S. 4809 IN THE SENATE June 17, 2026',
    );
  });

  it('separates nested siblings while keeping inline tags transparent', () => {
    const body =
      '<bill><section><label>SEC. 1.</label><heading>SHORT TITLE</heading><text>pre<em>formatted</em>text</text></section><section><label>SEC. 2.</label><text>Second.</text></section></bill>';
    expect(extractDocumentText(body)).toBe('SEC. 1. SHORT TITLE preformattedtext SEC. 2. Second.');
  });

  it('does not double literal whitespace or treat declarations and comments as boundaries', () => {
    expect(extractDocumentText('<root><a>one</a> \n <b>two</b></root>')).toBe('one \n two');
    expect(
      extractDocumentText(
        '<?xml version="1.0"?><root>pre<!-- note --><em>formatted</em>text</root>',
      ),
    ).toBe('preformattedtext');
  });

  it('does not add a sibling separator beside literal or decoded whitespace', () => {
    expect(extractDocumentText('<outer><a>one</a> </outer><b>two</b>')).toBe('one two');
    expect(extractDocumentText('<outer><a>one</a>\n</outer><b>two</b>')).toBe('one\ntwo');
    expect(extractDocumentText('<outer><a>one</a>&nbsp;</outer><b>two</b>')).toBe('one two');
    expect(extractDocumentText('<outer><a>one</a>&#32;</outer><b>two</b>')).toBe('one two');
    expect(extractDocumentText('<outer><a>one</a></outer><b>&#32;two</b>')).toBe('one two');
  });

  it('keeps adjacent inline spans and entities continuous', () => {
    expect(
      extractDocumentText(
        '<root>pre<em>form</em><strong>atted</strong><span>text</span><sub>2</sub><sup>x</sup></root>',
      ),
    ).toBe('preformattedtext2x');
    expect(extractDocumentText('<root>&am</i><b>p;</b></root>')).toBe('&');
  });

  it('separates a close-to-open transition when either element is structural', () => {
    expect(extractDocumentText('<root><label>One</label><em>Two</em></root>')).toBe('One Two');
    expect(extractDocumentText('<root><em>One</em><heading>Two</heading></root>')).toBe('One Two');
  });

  it('handles a body with no markup at all', () => {
    expect(extractDocumentText('plain text document')).toBe('plain text document');
  });

  it('returns an empty string for an empty or whitespace-only body', () => {
    expect(extractDocumentText('')).toBe('');
    expect(extractDocumentText('<pre>\n\n   \n</pre>')).toBe('');
  });

  /**
   * USLM bills open with `<preamble>`. Treating that as the `<pre>` wrapper
   * silently truncated a 2.6 MB document to the preamble's 223 characters — and
   * still reported a totalCharacters a caller had no way to doubt.
   */
  it('does not mistake <preamble> for a <pre> wrapper', () => {
    const body =
      '<bill><preamble>Short preamble.</preamble><section>Sec. 1. The operative text.</section></bill>';
    expect(extractDocumentText(body)).toBe('Short preamble. Sec. 1. The operative text.');
  });

  it('still unwraps a <pre> carrying attributes', () => {
    expect(extractDocumentText('<pre class="doc">body text</pre>')).toBe('body text');
  });

  it('takes everything between the first <pre> and the last </pre>', () => {
    const body = '<pre>first\n</pre>\n<pre>second</pre>';
    expect(extractDocumentText(body)).toBe('first\n\nsecond');
  });

  /**
   * Every character offset in the `content` contract is defined against this
   * function's output, so its exact behaviour — including on malformed markup —
   * is the specification a second implementation has to reproduce. These pin the
   * shapes www.congress.gov actually serves plus the edge cases where the
   * pipeline's stage order (normalize → strip comments → unwrap pre → strip tags
   * → decode entities → trim) is observable.
   */
  describe('pinned behaviour', () => {
    it('reads the GPO Formatted Text wrapper Congress.gov serves', () => {
      const body = '<html><body><pre>\n[Congressional Bills]\nSEC. 1.\n</pre></body></html>\n';
      expect(extractDocumentText(body)).toBe('[Congressional Bills]\nSEC. 1.');
    });

    it('reads the Formatted XML wrapper, declaration and doctype included', () => {
      const body =
        '<?xml version="1.0"?>\n<!DOCTYPE bill PUBLIC "x" "bill.dtd">\n<bill><text>Sec. 1.</text></bill> \n\n';
      expect(extractDocumentText(body)).toBe('Sec. 1.');
    });

    it('drops everything after the last </pre>', () => {
      expect(extractDocumentText('<pre>a</pre>tail')).toBe('a');
    });

    it('keeps the tail when the only </pre> is not past the opening tag', () => {
      expect(extractDocumentText('<pre></pre>tail')).toBe('tail');
    });

    it('keeps intervening text across several <pre> blocks', () => {
      expect(extractDocumentText('<pre>a</pre>mid<pre>b</pre>')).toBe('amidb');
    });

    it('ignores a </pre> that precedes the opening tag', () => {
      expect(extractDocumentText('</pre><pre>body')).toBe('body');
    });

    it('unwraps whitespace-padded and mixed-case pre tags', () => {
      expect(extractDocumentText('< pre >x< / PRE >tail')).toBe('x');
    });

    it('treats a self-closing <pre/> as the opening tag', () => {
      expect(extractDocumentText('<pre/>body')).toBe('body');
    });

    it('finds the leftmost <pre> even inside another tag', () => {
      expect(extractDocumentText('<a href="<pre>">after')).toBe('">after');
    });

    it('leaves an unterminated comment in the text', () => {
      expect(extractDocumentText('<pre>a<!--b</pre>')).toBe('a<!--b');
      expect(extractDocumentText('head<!--tail with > inside')).toBe('head inside');
    });

    it('leaves an unterminated tag in the text', () => {
      expect(extractDocumentText('<pre>a<b</pre>')).toBe('a<b');
      expect(extractDocumentText('alpha<beta')).toBe('alpha<beta');
    });

    it('takes only the first --> as the end of a comment', () => {
      expect(extractDocumentText('<!--a<!--b-->c')).toBe('c');
    });

    it('never sees a <pre> that a comment removed', () => {
      expect(extractDocumentText('<!--<pre>--><b>text</b>')).toBe('text');
    });

    it('joins an entity across a removed tag', () => {
      expect(extractDocumentText('<pre>&am<i>p;</pre>')).toBe('&');
    });

    it('joins an entity across a removed comment', () => {
      expect(extractDocumentText('&am<!--x-->p;')).toBe('&');
    });

    it('restarts an entity scan at a later ampersand', () => {
      expect(extractDocumentText('&&amp;')).toBe('&&');
      expect(extractDocumentText('&am&amp;')).toBe('&am&');
    });

    it('decodes a numeric reference through its leading zeros', () => {
      expect(extractDocumentText('&#0000065;')).toBe('A');
    });

    it('decodes upper- and lower-case hex references', () => {
      expect(extractDocumentText('&#x41;&#X42;')).toBe('AB');
    });

    it('emits a surrogate pair as two characters', () => {
      const text = extractDocumentText('&#128512;x');
      expect(text).toBe('😀x');
      expect(text).toHaveLength(3);
    });

    it('leaves a reference it cannot resolve verbatim', () => {
      expect(extractDocumentText('&abcdefghij;')).toBe('&abcdefghij;');
      expect(extractDocumentText('&#99999999;')).toBe('&#99999999;');
      expect(extractDocumentText('&#;')).toBe('&#;');
    });

    /**
     * U+0000 is no XML character, and in a no-`<pre>` body it is also the
     * sibling-boundary marker — decoding it let the marker pass swallow the
     * reference and insert a space the document never had.
     */
    it('leaves a reference to U+0000 verbatim in both readings', () => {
      expect(extractDocumentText('<root>x&#0;y</root>')).toBe('x&#0;y');
      expect(extractDocumentText('<pre>x&#x0000;y</pre>')).toBe('x&#x0000;y');
    });

    /** A surrogate code point is not a character; decoding one emits an unpaired code unit. */
    it('leaves a reference to a lone surrogate verbatim', () => {
      expect(extractDocumentText('<pre>a&#xD800;b&#57343;c</pre>')).toBe('a&#xD800;b&#57343;c');
    });

    it('keeps bare angle brackets that form no tag', () => {
      expect(extractDocumentText('a > b < c')).toBe('a > b < c');
    });

    it('trims decoded trailing whitespace, non-breaking space included', () => {
      expect(extractDocumentText('<pre>a   \n\n</pre>')).toBe('a');
      expect(extractDocumentText('<pre>a&nbsp;</pre>')).toBe('a');
      expect(extractDocumentText('<pre>   \n  </pre>')).toBe('');
    });
  });
});

/**
 * The `html` reading — CRS report pages. Like the GPO reading, the string is
 * what every `content` offset indexes into, so these pin it exactly: what is
 * markup, what is text, and where lines and paragraphs fall.
 */
describe('extractHtmlText', () => {
  it.each([
    ['a comment hiding a script', '<!-- <script>x</script> -->a', 'a'],
    ['a script end tag with trailing whitespace', '<script>x</script >b', 'b'],
    ['a mixed-case script closed by a line break', '<SCRIPT>x</script\n>c', 'c'],
    ['a script name split by a nested tag', '<scr<b>ipt>x</scr<b>ipt>y', 'ipt>xipt>y'],
    ['a CDATA section', '<![CDATA[x<y]]>z', 'z'],
    [
      'a table cell holding two paragraphs',
      '<table><tr><td><p>a</p><p>b</p></td><td>c</td></tr></table>',
      'a b\tc',
    ],
  ])('reads %s', (_label, body, expected) => {
    expect(extractHtmlText(body)).toBe(expected);
  });

  describe('dropped content', () => {
    it('drops script and style elements with everything inside them', () => {
      expect(extractHtmlText('a<script type="text/javascript">var x = "<p>";</script>b')).toBe(
        'ab',
      );
      expect(extractHtmlText('a<style>p { content: "</p>" }</style>b')).toBe('ab');
      expect(extractHtmlText('<script/>hidden</script>shown')).toBe('shown');
    });

    it('closes a raw-text element only with its own end tag', () => {
      expect(extractHtmlText('<script>a</style>b</script>c')).toBe('c');
      expect(extractHtmlText('<style>a</script>b</STYLE/>c')).toBe('c');
      expect(extractHtmlText('<script>a</scriptx>b</script>c')).toBe('c');
    });

    it('runs an unclosed script or style to the end of the document', () => {
      expect(extractHtmlText('a<script>b</script')).toBe('a');
      expect(extractHtmlText('a<style>b</sty')).toBe('a');
    });

    it('runs an unterminated comment to the end of the document', () => {
      expect(extractHtmlText('a<!-- b <p>c</p>')).toBe('a');
    });

    it('ends a comment where the HTML tokenizer does', () => {
      expect(extractHtmlText('<!-->a')).toBe('a');
      expect(extractHtmlText('<!--->a')).toBe('a');
      expect(extractHtmlText('<!---->a')).toBe('a');
      expect(extractHtmlText('<!-- x --!>a')).toBe('a');
      expect(extractHtmlText('<!-- x <!-- y -->a')).toBe('a');
      expect(extractHtmlText('<!--!>a')).toBe('');
      expect(extractHtmlText('<!---!>a')).toBe('');
    });

    it('reads declarations, processing instructions, and stray end tags as markup to the first >', () => {
      expect(extractHtmlText('<!DOCTYPE html>a')).toBe('a');
      expect(extractHtmlText('<?xml version="1.0"?>a')).toBe('a');
      expect(extractHtmlText('<!>a<!->b<!-x>c')).toBe('abc');
      expect(extractHtmlText('a</>b</ x>c</3>d')).toBe('abcd');
    });

    it('ends a tag at its first >, quotes or not', () => {
      expect(extractHtmlText('<a title="x>y">z</a>')).toBe('y">z');
    });

    it('drops an unterminated tag to the end of the document', () => {
      expect(extractHtmlText('alpha<beta')).toBe('alpha');
      expect(extractHtmlText('alpha</beta gamma')).toBe('alpha');
      expect(extractHtmlText('alpha<!DOCTYPE')).toBe('alpha');
    });

    it('drops every tag and attribute, footnote titles and link targets included', () => {
      expect(
        extractHtmlText(
          '<p>Text<sup><a class="FootnoteLink" title="The footnote body." href="#fn1">1</a></sup> continues.</p>',
        ),
      ).toBe('Text1 continues.');
    });
  });

  describe('kept text', () => {
    it('keeps a < that opens no tag', () => {
      expect(extractHtmlText('a < b <3 c<')).toBe('a < b <3 c<');
      expect(extractHtmlText('x</')).toBe('x</');
      expect(extractHtmlText('<')).toBe('<');
    });

    it('keeps text the report template shows, escaped directive included', () => {
      expect(
        extractHtmlText(
          '<head><meta charset="utf-8"/></head>\n    &lt;%@ Control Language="C#" %&gt;\n    <script language="C#" runat="server">public string X;</script><div class="Title">Voter Registration</div>',
        ),
      ).toBe('<%@ Control Language="C#" %>\nVoter Registration');
    });

    it('collapses each run of ASCII whitespace to one space and trims the ends', () => {
      expect(extractHtmlText('  a \n\t b\r\n\fc  ')).toBe('a b c');
      expect(extractHtmlText(' \n\t ')).toBe('');
      expect(extractHtmlText('')).toBe('');
    });

    it('keeps a non-breaking space as text, at the ends too', () => {
      expect(extractHtmlText('a&nbsp;&#160;b')).toBe('a  b');
      expect(extractHtmlText('&nbsp;a&nbsp;')).toBe(' a ');
    });

    it('collapses whitespace that a reference decodes to', () => {
      expect(extractHtmlText('a&#32; &#10;&#x9;b')).toBe('a b');
    });
  });

  describe('character references', () => {
    it('decodes references once', () => {
      expect(extractHtmlText('&amp;lt; &lt;b&gt; &quot;q&quot; &#x2014; &#8212;')).toBe(
        '&lt; <b> "q" — —',
      );
    });

    it('never turns a decoded < into markup', () => {
      expect(extractHtmlText('&lt;script&gt;x&lt;/script&gt;y')).toBe('<script>x</script>y');
    });

    it('leaves a reference it does not recognize verbatim', () => {
      expect(extractHtmlText('&copy; &#0; &#xD800; &#99999999; &#; &abcdefghij;')).toBe(
        '&copy; &#0; &#xD800; &#99999999; &#; &abcdefghij;',
      );
    });

    it('never joins a reference across markup', () => {
      expect(extractHtmlText('&am<i>p;')).toBe('&amp;');
      expect(extractHtmlText('&am<!-- x -->p;')).toBe('&amp;');
    });

    it('restarts a reference at a later ampersand and reads through leading zeros', () => {
      expect(extractHtmlText('&&amp; &am&amp; &#0000065;')).toBe('&& &am& A');
    });
  });

  describe('layout', () => {
    it('puts a blank line between paragraph-level blocks', () => {
      expect(extractHtmlText('<p>a</p><p>b</p>')).toBe('a\n\nb');
      expect(extractHtmlText('<h1>Contents</h1><ul><li>a</li><li>b</li></ul>after')).toBe(
        'Contents\n\na\nb\n\nafter',
      );
      expect(
        extractHtmlText('a<h2>b</h2><h6>c</h6><ol><li>d</li></ol><blockquote>e</blockquote>f'),
      ).toBe('a\n\nb\n\nc\n\nd\n\ne\n\nf');
      expect(extractHtmlText('a<hr color="#003399"/>b')).toBe('a\n\nb');
    });

    it('ends a line at div, li, tr, and br', () => {
      expect(extractHtmlText('<div>a</div><div>b</div>c<br/>d<BR>e</br>f')).toBe(
        'a\nb\nc\nd\ne\nf',
      );
    });

    it('never puts more than one blank line between text', () => {
      expect(extractHtmlText('<p>a</p><p></p>\n<p> </p><br><div></div><p>b</p>')).toBe('a\n\nb');
    });

    it('trims each line', () => {
      expect(extractHtmlText('<p>  a  </p>  <p>\n b \n</p>')).toBe('a\n\nb');
      expect(extractHtmlText('a <br> b')).toBe('a\nb');
    });

    it('keeps inline elements inline', () => {
      expect(
        extractHtmlText(
          '<p>pre<em>formatted</em> <strong>text</strong><span class="Hyperlink">!</span></p>',
        ),
      ).toBe('preformatted text!');
    });

    it('lays a table row out on one line, cells joined by tabs', () => {
      expect(
        extractHtmlText(
          '<p>Table 1</p><table><tr><th>Year</th><th>OASI</th></tr>\n<tr>\n<td> 2026 </td>\n<td>$1,234</td>\n</tr></table><p>Source</p>',
        ),
      ).toBe('Table 1\n\nYear\tOASI\n2026\t$1,234\n\nSource');
    });

    it('turns block breaks inside a cell into spaces', () => {
      expect(
        extractHtmlText(
          '<table><tr><td><div>a</div><br>b<ul><li>c</li></ul><hr>d</td><td>e</td></tr></table>',
        ),
      ).toBe('a b c d\te');
    });

    it('keeps the tab of an empty cell before or between filled ones and drops it after the last', () => {
      expect(
        extractHtmlText(
          '<table><tr><td>a</td><td></td><td>c</td></tr><tr><td></td><td>e</td><td></td></tr><tr><td>g</td></tr></table>',
        ),
      ).toBe('a\t\tc\n\te\ng');
    });

    it('separates a cell whose end tag was omitted', () => {
      expect(extractHtmlText('<table><tr><td>a<td>b<tr><td>c</table>')).toBe('a\tb\nc');
    });

    it('lays a nested table out on its own lines and keeps the outer cells apart', () => {
      expect(
        extractHtmlText(
          '<table><tr><td>x<table><tr><td>a</td><td>b</td></tr></table>y</td><td>z</td></tr></table>',
        ),
      ).toBe('x\n\na\tb\n\ny\tz');
    });

    it('keeps a top-level one-row table a row of tab-joined cells', () => {
      expect(extractHtmlText('<p>a</p><table><tr><td>$838</td><td>.2</td></tr></table>')).toBe(
        'a\n\n$838\t.2',
      );
    });

    /**
     * CRS reports wrap a figure in a one-row table at the start of its cell —
     * one cell to right-align it, two to split it at the decimal point. A table
     * that opens a cell before any of the cell's text is the cell's content:
     * its rows separate like any block inside a cell, and its cells add nothing.
     */
    describe('a table that opens a cell', () => {
      it.each([
        [
          'a figure split at its decimal point',
          '<table><tr><td><p>2021</p></td><td><p><table><tr><td>$838</td><td>.2</td></tr></table></p></td></tr></table>',
          '2021\t$838.2',
        ],
        [
          'an empty one after a no-break space',
          '<table><tr><td>a</td><td>&nbsp;<p><table><tr><td></td></tr></table></p></td><td>c</td></tr></table>',
          'a\t \tc',
        ],
        [
          'one the rest of its cell follows',
          '<table><tr><td><table><tr><td>750</td></tr></table><p>(est.)</p></td><td>c</td></tr></table>',
          '750 (est.)\tc',
        ],
        [
          'one of several rows',
          '<table><tr><td><table><tr><td>a</td></tr><tr><td>b</td></tr></table></td><td>c</td></tr></table>',
          'a b\tc',
        ],
        [
          'one left open, which ends at the next </table>',
          '<table><tr><td><table><tr><td>1</td></tr></td><td>2</td></tr></table><p>after</p>',
          '1 2 after',
        ],
        [
          'one inside another',
          '<table><tr><td><table><tr><td><table><tr><td>$1</td><td>.5</td></tr></table></td></tr></table></td><td>c</td></tr></table>',
          '$1.5\tc',
        ],
        [
          'one after an empty one in the same cell',
          '<table><tr><td><table><tr><td></td></tr></table><table><tr><td>750</td></tr></table></td><td>c</td></tr></table>',
          '750\tc',
        ],
        [
          'one in a cell whose end tag was omitted',
          '<table><tr><td>a<td><table><tr><td>1</td></tr></table><td>c</table>',
          'a\t1\tc',
        ],
        [
          'one after an em space',
          '<table><tr><td>a</td><td>&#x2003;<table><tr><td>1</td></tr></table></td></tr></table>',
          'a\t  1',
        ],
        [
          'one never closed, to the end of the document',
          '<table><tr><td><table><tr><td>a</td></tr><tr><td>b<p>c</p>',
          'a b c',
        ],
      ])('reads %s as the cell’s content', (_label, body, expected) => {
        expect(extractHtmlText(body)).toBe(expected);
      });

      it('lays out a table that opens after text in its cell as its own block', () => {
        expect(
          extractHtmlText(
            '<table><tr><td><table><tr><td>a</td></tr></table><table><tr><td>b</td><td>c</td></tr></table>d</td><td>e</td></tr></table>',
          ),
        ).toBe('a\n\nb\tc\n\nd\te');
        expect(
          extractHtmlText(
            '<table><tr><td>&lt;<table><tr><td>a</td><td>b</td></tr></table></td></tr></table>',
          ),
        ).toBe('<\n\na\tb');
      });

      it('reads a cell-opening table inside a nested table as that inner cell’s content', () => {
        expect(
          extractHtmlText(
            '<table><tr><td>x<table><tr><td><table><tr><td>1</td></tr></table></td><td>2</td></tr></table>y</td><td>z</td></tr></table>',
          ),
        ).toBe('x\n\n1\t2\n\ny\tz');
      });

      it('keeps each row of a CRS figure table on one line', () => {
        const label = (text: string) =>
          `<td style="width:114.7pt;" valign="top">\n<p class="TableText" style="padding-left:18pt;">${text}</p>\n</td>\n`;
        const figure = (value: string) =>
          `<td style="width:39.2pt;" valign="top">\n<p class="TableText" style="">\n<table border="0" cellpadding="0" cellspacing="0">\n<tr>\n<td style="width:59.75pt;text-align:right;" valign="top">${value}</td>\n</tr>\n</table>\n</p>\n</td>\n`;
        const blank =
          '<td style="width:39.2pt;" valign="top"> <p class="TableText" style="">\n<table border="0" cellpadding="0" cellspacing="0">\n<tr>\n<td style="width:59.75pt;text-align:right;" valign="top"></td>\n</tr>\n</table>\n</p>\n</td>\n';
        const body = `<table>\n<tr style="height:15pt;">\n${label('<strong>Title III. Trade</strong>')}${blank}${blank}</tr>\n<tr style="height:15pt;">\n${label('Authorization of appropriations')}${figure('750')}${figure('750')}</tr>\n<tr style="height:15pt;">\n${label('Estimated outlays')}${figure('627')}${figure('750')}</tr>\n</table>`;
        expect(extractHtmlText(body)).toBe(
          'Title III. Trade\t \t \nAuthorization of appropriations\t750\t750\nEstimated outlays\t627\t750',
        );
      });

      it('joins each CRS figure split at its decimal point', () => {
        const split = (whole: string, fraction: string) =>
          `<td valign="middle">\n<p class="TableText" style="text-align:center;">\n<table border="0" cellpadding="0" cellspacing="0">\n<tr>\n<td style="width:36pt;text-align:right;" valign="top">${whole}</td><td valign="top">${fraction}</td>\n</tr>\n</table>\n</p>\n</td>\n`;
        const body = `<table><tr style="">\n<td valign="middle">\n<p class="TableText" style="text-align:center;">2021</p>\n</td>\n${split('$838', '.2')}${split('$142', '.4')}${split('$980', '.6')}</tr></table>`;
        expect(extractHtmlText(body)).toBe('2021\t$838.2\t$142.4\t$980.6');
      });
    });

    it('reads a footnote list as number, tab, text', () => {
      expect(
        extractHtmlText(
          '<h1>Footnotes</h1><table><tr><td valign="top"><a class="FootnoteBL" href="#ifn1" name="fn1">1</a>.\n </td>\n<td>\n<p class="FootnoteText"> See <a href="x"><em>Report</em></a>, p. 2.</p>\n</td>\n</tr></table>',
        ),
      ).toBe('Footnotes\n\n1.\tSee Report, p. 2.');
    });
  });
});

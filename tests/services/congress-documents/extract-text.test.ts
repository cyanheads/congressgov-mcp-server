/**
 * @fileoverview Tests for the GPO `<pre>` → plain-text extractor. The extracted
 * string is what every character offset indexes into, so these pin exactness:
 * verbatim whitespace, single-pass entity decoding, and deterministic newlines.
 * @module tests/services/congress-documents/extract-text.test
 */

import { describe, expect, it } from 'vitest';
import { extractDocumentText } from '@/services/congress-documents/extract-text.js';

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
    expect(extractDocumentText(body)).toBe('Short preamble.Sec. 1. The operative text.');
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

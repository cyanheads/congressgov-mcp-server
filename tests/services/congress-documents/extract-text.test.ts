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
});

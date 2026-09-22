/**
 * @fileoverview Tests for the shared single-pass character-reference decoder that
 * every HTML/XML → text path in the server runs through.
 * @module tests/utils/character-references.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCharacterReference,
  decodeCharacterReferences,
} from '@/utils/character-references.js';

/** What `&nbsp;` resolves to — the real U+00A0, not an ASCII space. */
const NBSP = String.fromCharCode(0xa0);

describe('decodeCharacterReferences', () => {
  it('decodes the named references Congress.gov and GPO emit', () => {
    expect(decodeCharacterReferences('&amp; &lt; &gt; &quot; &apos; a&nbsp;b')).toBe(
      `& < > " ' a${NBSP}b`,
    );
  });

  it('matches named references case-insensitively', () => {
    expect(decodeCharacterReferences('&AMP; &Lt; &NBSP;')).toBe(`& < ${NBSP}`);
  });

  it('decodes decimal and hex references, leading zeros included', () => {
    expect(decodeCharacterReferences('&#39;&#039;&#x26;&#X2014;&#0000065;')).toBe("''&—A");
  });

  it('decodes an astral code point to its surrogate pair', () => {
    expect(decodeCharacterReferences('&#128512;&#x1F600;')).toBe('😀😀');
  });

  it('decodes each reference exactly once', () => {
    expect(decodeCharacterReferences('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeCharacterReferences('&amp;amp; &amp;#39; &amp;quot;')).toBe('&amp; &#39; &quot;');
  });

  it('decodes the code points at the edges of each valid range', () => {
    expect(decodeCharacterReferences('&#x1;&#xD7FF;&#xE000;&#x10FFFF;')).toBe(
      `\u0001${String.fromCodePoint(0xd7ff)}${String.fromCodePoint(0xe000)}${String.fromCodePoint(0x10ffff)}`,
    );
  });

  it('leaves unrecognized and malformed references verbatim', () => {
    const verbatim = '&notarealentity; &#; &#x; &#xG1; &amp &#65 & ;';
    expect(decodeCharacterReferences(verbatim)).toBe(verbatim);
  });

  it('leaves references to code points no string can carry verbatim', () => {
    const verbatim = '&#0; &#x0000; &#xD800; &#xDFFF; &#56320; &#x110000; &#1114112;';
    expect(decodeCharacterReferences(verbatim)).toBe(verbatim);
  });

  it('returns text with no references unchanged', () => {
    expect(decodeCharacterReferences('')).toBe('');
    expect(decodeCharacterReferences('AT&T; Q&A')).toBe('AT&T; Q&A');
  });
});

describe('decodeCharacterReference', () => {
  it('resolves the body of one reference', () => {
    expect(decodeCharacterReference('amp')).toBe('&');
    expect(decodeCharacterReference('#x41')).toBe('A');
    expect(decodeCharacterReference('#65')).toBe('A');
  });

  it('returns undefined for a body it cannot resolve', () => {
    expect(decodeCharacterReference('bogus')).toBeUndefined();
    expect(decodeCharacterReference('#0')).toBeUndefined();
    expect(decodeCharacterReference('#xD800')).toBeUndefined();
    expect(decodeCharacterReference('#x110000')).toBeUndefined();
  });
});

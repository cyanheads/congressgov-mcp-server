/**
 * @fileoverview Tests for the bill mirror's pure normalizers — the HTML → plain
 * text reduction that feeds the FTS index and summary previews, and FTS5 `MATCH`
 * escaping.
 * @module tests/services/congress-mirror/normalize.test
 */

import { describe, expect, it } from 'vitest';
import { htmlToPlainText, toFtsMatch } from '@/services/congress-mirror/normalize.js';

describe('htmlToPlainText', () => {
  it('flattens a CRS summary to one line of words', () => {
    const html =
      '<p><strong>Firefighter Cancer Registry Reauthorization Act of 2023</strong></p><p>This act&nbsp;reauthorizes the registry.</p><ul><li>First;</li><li>Second.&nbsp;</li></ul><p>Afterward.<br/>Next line.</p>';
    expect(htmlToPlainText(html)).toBe(
      'Firefighter Cancer Registry Reauthorization Act of 2023 This act reauthorizes the registry. First; Second. Afterward. Next line.',
    );
  });

  it('decodes the entities the summaries carry', () => {
    expect(
      htmlToPlainText(
        '<p>Texas A&amp;M&nbsp;University&#039;s &#39;own&#39; &quot;role&quot; &lt;per the record&gt;</p>',
      ),
    ).toBe("Texas A&M University's 'own' \"role\" <per the record>");
  });

  it('keeps an unrecognized named reference verbatim', () => {
    expect(htmlToPlainText('<p>a &notarealentity; b</p>')).toBe('a &notarealentity; b');
  });

  it('decodes each reference exactly once, so escaped references stay escaped', () => {
    expect(htmlToPlainText('<p>Literal &amp;lt;b&amp;gt; and &amp;quot;x&amp;quot;</p>')).toBe(
      'Literal &lt;b&gt; and &quot;x&quot;',
    );
  });

  it('decodes decimal and hex numeric references', () => {
    expect(htmlToPlainText('<p>plan &#x26; more &#8212; done</p>')).toBe('plan & more — done');
  });

  it('returns an empty string for markup with no text', () => {
    expect(htmlToPlainText('<p> </p><ul></ul>')).toBe('');
  });
});

describe('toFtsMatch', () => {
  it('quotes each token and AND-combines them', () => {
    expect(toFtsMatch('  semiconductor  export-control ')).toBe(
      '"semiconductor" AND "export-control"',
    );
  });

  it('strips embedded quotes and drops tokens left empty', () => {
    expect(toFtsMatch('"NEAR" "')).toBe('"NEAR"');
  });

  it('returns an empty expression for whitespace-only input', () => {
    expect(toFtsMatch('   ')).toBe('');
  });
});

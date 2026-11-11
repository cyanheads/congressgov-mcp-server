/**
 * @fileoverview Tests for the bill mirror's pure normalizers — the HTML → plain
 * text reduction that feeds the FTS index and summary previews, and the search
 * query grammar's translation to an FTS5 `MATCH` expression: the operator table,
 * the exclusions and unmatched marks it reports, the queries it rejects, and its cost over
 * caller-sized input. That every translation runs against a real FTS5 index is
 * proven through the service in `congress-mirror-service.test.ts`.
 * @module tests/services/congress-mirror/normalize.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
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
  /** The expression the pre-grammar translation produced for plain keywords, unchanged. */
  it('quotes each word and AND-combines them', () => {
    expect(toFtsMatch('  semiconductor  export-control ')).toEqual({
      match: '"semiconductor" AND "export-control"',
      unmatched: [],
      exclusions: [],
    });
  });

  it.each([
    ['wildfire smoke', '"wildfire" AND "smoke"', []],
    ['wildfire AND smoke', '"wildfire" AND "smoke"', []],
    ['"smoke exposure"', '"smoke exposure"', []],
    ['wildfire OR drought', '"wildfire" OR "drought"', []],
    ['wildfire -smoke', '"wildfire" NOT "smoke"', ['-']],
    ['-smoke wildfire', '"wildfire" NOT "smoke"', ['-']],
    ['wildfire NOT smoke', '"wildfire" NOT "smoke"', ['NOT']],
    ['NOT smoke wildfire', '"wildfire" NOT "smoke"', ['NOT']],
    ['wildfire AND NOT smoke', '"wildfire" NOT "smoke"', ['NOT']],
    ['wildfire drought -smoke -heat', '("wildfire" AND "drought") NOT ("smoke" OR "heat")', ['-']],
    ['wildfire OR drought -smoke', '("wildfire" OR "drought") NOT "smoke"', ['-']],
    ['wildfire -smoke OR drought', '("wildfire" OR "drought") NOT "smoke"', ['-']],
    ['wildfire (drought OR smoke)', '"wildfire" AND ("drought" OR "smoke")', []],
    ['(drought OR smoke) wildfire', '("drought" OR "smoke") AND "wildfire"', []],
    ['(a b) OR c', '("a" AND "b") OR "c"', []],
    ['a (b c)', '"a" AND "b" AND "c"', []],
    ['a OR (b OR c)', '"a" OR "b" OR "c"', []],
    ['((wildfire))', '"wildfire"', []],
    ['wildfire -(smoke OR drought)', '"wildfire" NOT ("smoke" OR "drought")', ['-']],
    ['wildfire NOT (smoke OR drought)', '"wildfire" NOT ("smoke" OR "drought")', ['NOT']],
    ['a (b -c)', '"a" AND ("b" NOT "c")', ['-']],
    ['(a (b -c))', '"a" AND ("b" NOT "c")', ['-']],
    ['a ((b OR c)) d', '"a" AND ("b" OR "c") AND "d"', []],
    ['a OR (b (c OR d))', '"a" OR ("b" AND ("c" OR "d"))', []],
    ['x -(((a b)))', '"x" NOT ("a" AND "b")', ['-']],
    ['x NOT ((a b))', '"x" NOT ("a" AND "b")', ['NOT']],
    ['x -((smoke OR drought))', '"x" NOT ("smoke" OR "drought")', ['-']],
    ['x -(a (b c))', '"x" NOT ("a" AND "b" AND "c")', ['-']],
    ['-"smoke exposure" smoke', '"smoke" NOT "smoke exposure"', ['-']],
    ['wildfire NOT "smoke exposure"', '"wildfire" NOT "smoke exposure"', ['NOT']],
    ['wild*', '"wild"*', []],
    ['wild** -wilder*', '"wild"* NOT "wilder"*', ['-']],
    ['(wild*)', '"wild"*', []],
    ['oil & gas', '"oil" AND "gas"', []],
    ['wildfire - smoke', '"wildfire" AND "smoke"', []],
    ['wildfire () "" * drought', '"wildfire" AND "drought"', []],
    ['solar or wind', '"solar" AND "or" AND "wind"', []],
    ['solar and wind not hydro', '"solar" AND "and" AND "wind" AND "not" AND "hydro"', []],
    ['"OR" solar', '"OR" AND "solar"', []],
    ['-OR solar', '"solar" NOT "OR"', ['-']],
    ['OR* solar', '"OR"* AND "solar"', []],
    ['NEAR wildfire', '"NEAR" AND "wildfire"', []],
    ['title:wildfire', '"title:wildfire"', []],
    ['{title}:wildfire ^x +y', '"{title}:wildfire" AND "^x" AND "+y"', []],
    ['501(c)(3)', '"501(c)(3)"', []],
    ['(501(c)(3))', '"501(c)(3)"', []],
    ['export-control', '"export-control"', []],
    ['--smoke wildfire', '"wildfire" NOT "-smoke"', ['-']],
    ['say"hi"there', '"say" AND "hi" AND "there"', []],
    ['café 半導体 ١٢٣', '"café" AND "半導体" AND "١٢٣"', []],
  ])('translates %o', (query, match, exclusions) => {
    expect(toFtsMatch(query)).toEqual({ match, unmatched: [], exclusions });
  });

  it.each([
    ['DO NOT CALL', '"DO" NOT "CALL"', ['NOT']],
    ['covid -19', '"covid" NOT "19"', ['-']],
    ['wildfire NOT smoke -heat', '"wildfire" NOT ("smoke" OR "heat")', ['NOT', '-']],
    ['wildfire -heat NOT smoke', '"wildfire" NOT ("heat" OR "smoke")', ['-', 'NOT']],
    ['a -b -c NOT d NOT e', '"a" NOT ("b" OR "c" OR "d" OR "e")', ['-', 'NOT']],
    /** The group's NOT is translated after the `-b` inside it, yet comes first in the query. */
    ['NOT (a -b) c', '"c" NOT ("a" NOT "b")', ['NOT', '-']],
    ['(a NOT b) -c', '("a" NOT "b") NOT "c"', ['NOT', '-']],
    ['x -(a OR b) NOT y', '"x" NOT ("a" OR "b" OR "y")', ['-', 'NOT']],
    ['x -NOT', '"x" NOT "NOT"', ['-']],
    ['"do not call" x', '"do not call" AND "x"', []],
    ['"NOT" call', '"NOT" AND "call"', []],
    ['do not call', '"do" AND "not" AND "call"', []],
    ['covid-19', '"covid-19"', []],
    ['a OR b (c d) e*', '"a" OR ("b" AND "c" AND "d" AND "e"*)', []],
  ])(
    'reports the exclusions %o used, each once, in the order the query first uses them',
    (query, match, exclusions) => {
      expect(toFtsMatch(query)).toEqual({ match, unmatched: [], exclusions });
    },
  );

  it.each([
    ['NUL', '\u0000'],
    ['a C0 control', '\u0001'],
    ['a unit separator', '\u001f'],
    ['DEL', '\u007f'],
    ['a C1 control', '\u0085'],
    ['a no-break space', ' '],
    ['a line separator', ' '],
    ['a byte-order mark', '﻿'],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', '\udfff'],
  ])('separates terms at %s, in a word and in a phrase', (_label, separator) => {
    expect(toFtsMatch(`wildfire${separator}smoke`).match).toBe('"wildfire" AND "smoke"');
    expect(toFtsMatch(`"smoke${separator}exposure"`).match).toBe('"smoke exposure"');
    expect(toFtsMatch(`wildfire${separator}OR${separator}drought`).match).toBe(
      '"wildfire" OR "drought"',
    );
  });

  it('keeps a surrogate pair inside its word', () => {
    expect(toFtsMatch('wildfire𠀀 🔥smoke').match).toBe('"wildfire𠀀" AND "🔥smoke"');
  });

  it.each([
    ['wildfire (smoke', '"wildfire" AND "smoke"', ['('], []],
    ['wildfire smoke)', '"wildfire" AND "smoke"', [')'], []],
    ['"smoke exposure', '"smoke" AND "exposure"', ['"'], []],
    ['("smoke exposure', '"smoke" AND "exposure"', ['(', '"'], []],
    [') wildfire (', '"wildfire"', [')', '('], []],
    ['(a) b) (c', '"a" AND "b" AND "c"', [')', '('], []],
    ['don"t', '"dont"', ['"'], []],
    ['"NEAR" "', '"NEAR"', ['"'], []],
    ['"a" "b" "c', '"a" AND "b" AND "c"', ['"'], []],
    ['NEAR(wildfire smoke)', '"NEAR(wildfire" AND "smoke"', [')'], []],
    /** The ignored `-(` still excludes the term after it. */
    ['-(smoke wildfire', '"wildfire" NOT "smoke"', ['('], ['-']],
    ['"smoke exposure (', '"smoke" AND "exposure"', ['"', '('], []],
    ['wildfire" (smoke', '"wildfire" AND "smoke"', ['"', '('], []],
    ['(DO NOT CALL', '"DO" NOT "CALL"', ['('], ['NOT']],
  ])(
    'ignores the unmatched marks in %o and reports them in order',
    (query, match, unmatched, exclusions) => {
      expect(toFtsMatch(query)).toEqual({ match, unmatched, exclusions });
    },
  );

  /** The error `toFtsMatch(query)` throws, asserting it is `invalid_query`. */
  function rejection(query: string): McpError {
    try {
      toFtsMatch(query);
    } catch (error) {
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_query', retryable: false },
      });
      return error as McpError;
    }
    throw new Error(`expected ${JSON.stringify(query)} to fail invalid_query`);
  }

  const NOTHING_TO_SEARCH =
    'The query has no term to search for. Search with at least one word that holds a letter or digit.';
  const missing = (operator: 'AND' | 'OR') =>
    `${operator} needs a term to search for on each side, as in wildfire ${operator} drought. Quote it ("${operator}") to search for the word itself.`;
  const MISSING_NOT =
    'NOT needs a term after it to exclude, as in wildfire NOT smoke. Quote it ("NOT") to search for the word itself.';

  it.each([
    ['', NOTHING_TO_SEARCH],
    ['   ', NOTHING_TO_SEARCH],
    ['& - ()', NOTHING_TO_SEARCH],
    ['((((', NOTHING_TO_SEARCH],
    ['OR', missing('OR')],
    ['OR wildfire', missing('OR')],
    ['wildfire OR', missing('OR')],
    ['wildfire OR OR drought', missing('OR')],
    ['wildfire OR () ', missing('OR')],
    ['-smoke OR wildfire', missing('OR')],
    ['wildfire OR -smoke', missing('OR')],
    ['wildfire OR NOT smoke', missing('OR')],
    ['AND wildfire', missing('AND')],
    ['wildfire AND', missing('AND')],
    ['wildfire AND OR drought', missing('AND')],
    ['(AND wildfire)', missing('AND')],
    ['NOT', MISSING_NOT],
    ['wildfire NOT', MISSING_NOT],
    ['wildfire NOT NOT smoke', MISSING_NOT],
    ['wildfire NOT -smoke', MISSING_NOT],
    ['wildfire NOT ()', MISSING_NOT],
    ['wildfire NOT)', MISSING_NOT],
    ['wildfire NOT -(smoke', MISSING_NOT],
    ['wildfire NOT -(smoke)', MISSING_NOT],
    ['wildfire NOT -(smoke OR heat)', MISSING_NOT],
    ['wildfire NOT -((smoke)', MISSING_NOT],
  ])('rejects %o as invalid_query', (query, message) => {
    expect(rejection(query).message).toBe(message);
  });

  it.each([
    ['-smoke', '-smoke'],
    ['NOT smoke', 'NOT smoke'],
    ['-"smoke exposure"', '-"smoke exposure"'],
    ['-(smoke OR drought)', '-(smoke OR drought)'],
    ['-wild* -smoke', '-wild*'],
  ])('rejects %o, with no term to search for, naming %o', (query, token) => {
    const error = rejection(query);
    expect(error.message).toBe(
      `The query has no term to search for: ${token} only excludes. Add a term to search for beside it, as in wildfire ${token}.`,
    );
    expect(error.literals).toEqual([token]);
  });

  it('rejects a group with no term to search for, naming the group and its exclusion', () => {
    expect(rejection('wildfire (-smoke NOT heat)').message).toBe(
      'The group (-smoke NOT heat) has no term to search for: -smoke only excludes. Add a term to search for inside the group, or move -smoke out of it.',
    );
  });

  /** Words of one bill row, so the nested and flat forms can be compared through the service too. */
  const TWELVE_LEVELS =
    'wildfire (smoke (crop (insurance (act (covers (crops (damaged (drought (flood (losses (exposure (cover))))))))))))';

  it('translates nesting that leaves the result unchanged at any depth, as the keyword translation did', () => {
    expect(toFtsMatch(`${'('.repeat(12)}wildfire${')'.repeat(12)}`)).toEqual({
      match: '"wildfire"',
      unmatched: [],
      exclusions: [],
    });
    expect(toFtsMatch(TWELVE_LEVELS)).toEqual({
      match:
        '"wildfire" AND "smoke" AND "crop" AND "insurance" AND "act" AND "covers" AND "crops" AND "damaged" AND "drought" AND "flood" AND "losses" AND "exposure" AND "cover"',
      unmatched: [],
      exclusions: [],
    });
    expect(toFtsMatch(`${'('.repeat(50_000)}wildfire${')'.repeat(50_000)}`).match).toBe(
      '"wildfire"',
    );
    expect(toFtsMatch(`${'(a '.repeat(20_000)}x${')'.repeat(20_000)}`).match).toBe(
      `${'"a" AND '.repeat(20_000)}"x"`,
    );
    expect(toFtsMatch(`x -${'('.repeat(50)}a b${')'.repeat(50)}`).match).toBe(
      '"x" NOT ("a" AND "b")',
    );
    expect(toFtsMatch(`${'('.repeat(40)}wildfire`).unmatched).toEqual(['(']);
  });

  const TOO_DEEP =
    'The query nests groups that hold OR or an exclusion, or are excluded, more than 10 levels deep. Flatten some of those groups.';

  /** `template` with `C` replaced by the next level, `depth` times, around `core`. */
  function nest(depth: number, template: string, core: string): string {
    let query = core;
    for (let level = 0; level < depth; level++) query = template.replace('C', `(${query})`);
    return query;
  }

  it.each([
    ['groups that hold OR', 'a OR C', 'b OR c'],
    ['groups that hold an exclusion', 'a -x C', 'b -c'],
    ['excluded groups', 'a -C', 'b c'],
    ['groups that hold OR, inside one-item groups', 'a OR ((C))', 'b OR c'],
    ['groups that hold OR, inside AND groups', 'a OR (b C)', 'c OR d'],
  ])('counts %s: 10 levels translate, an 11th fails', (_label, template, core) => {
    expect(toFtsMatch(nest(10, template, core)).match).toContain('"a"');
    expect(rejection(nest(11, template, core)).message).toBe(TOO_DEEP);
  });

  it('counts an AND group excluded through one-item groups, but never a one-item group itself', () => {
    expect(toFtsMatch(nest(9, 'a OR C', 'x -(((y z)))')).match).toMatch(/^"a" OR /);
    expect(rejection(nest(10, 'a OR C', 'x -(((y z)))')).message).toBe(TOO_DEEP);
    expect(toFtsMatch(nest(10, 'a OR C', 'x -(((y)))')).match).toMatch(/^"a" OR /);
  });
});

/**
 * The translation scans the query once and builds each term from slices, so
 * its cost grows with the query's length. These time it, in the thread's own
 * CPU time, on shapes a re-scanning scanner turns quadratic on.
 */
describe('toFtsMatch timing', () => {
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

  /** Translate `query`; a shape built to have nothing to search must fail `invalid_query`, and only that. */
  function translate(query: string, rejected: boolean): void {
    try {
      toFtsMatch(query);
    } catch (error) {
      if (rejected && (error as McpError).data?.reason === 'invalid_query') return;
      throw error;
    }
    if (rejected) throw new Error('expected the shape to fail invalid_query');
  }

  /** CPU microseconds per character a linear translation stays well inside; a quadratic one is far outside past 20k. */
  const MICROS_PER_CHARACTER = 2;

  /** Least per-call time of `query`, batched to span ~160k characters so the timer's resolution never dominates. */
  function time(query: string, rejected: boolean): number {
    const batch = Math.max(1, Math.round(160_000 / Math.max(1, query.length)));
    return leastCpuMicrosPerCall(() => translate(query, rejected), batch);
  }

  /**
   * Doubles from `from` characters through 64× that, checking the absolute bound
   * at each size before building the next, so a quadratic fails in seconds.
   * Returns the full span's growth over a baseline timed beside it, the least of
   * two such pairs.
   */
  function growth(build: (chars: number) => string, rejected: boolean, from: number): number {
    const base = build(from);
    let query = base;
    let micros = 0;
    for (let chars = from * 2; chars <= from * 64; chars *= 2) {
      query = build(chars);
      micros = time(query, rejected);
      expect(micros, `${query.length} chars`).toBeLessThan(query.length * MICROS_PER_CHARACTER);
    }
    const first = micros / time(base, rejected);
    return Math.min(first, time(query, rejected) / time(base, rejected));
  }

  const repeatTo = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  /** Shapes whose tokens stay short: the full 5k → 320k span. */
  const SHORT_TOKENS: ReadonlyArray<readonly [string, (chars: number) => string, boolean]> = [
    ['one long line ending in a break', (chars) => `${repeatTo('§1 x', chars)}\ny`, false],
    ['line breaks throughout', (chars) => repeatTo('  \r\n', chars), true],
    ['a run of openers with no closer', (chars) => repeatTo('(', chars), true],
    ['a run of quotes', (chars) => repeatTo('""', chars), true],
    ['a run of quotes with one unmatched', (chars) => `${repeatTo('""', chars)}"x`, false],
    ['a run of closers', (chars) => `x${repeatTo(')', chars)}`, false],
    [
      'one term nested in every group',
      (chars) => `${repeatTo('(', chars / 2)}x${repeatTo(')', chars / 2)}`,
      false,
    ],
    [
      'AND groups nested in every group',
      (chars) => `${repeatTo('(a ', (chars * 3) / 4)}x${repeatTo(')', chars / 4)}`,
      false,
    ],
    [
      'one-item groups around an excluded AND group',
      (chars) => `x -${repeatTo('(', chars / 2)}a b${repeatTo(')', chars / 2)}`,
      false,
    ],
    ['an OR chain', (chars) => `${repeatTo('x OR ', chars)}y`, false],
    ['an exclusion run', (chars) => `${repeatTo('-x ', chars)}y`, false],
    ['many phrases', (chars) => repeatTo('"a b" ', chars), false],
    ['a phrase of line breaks', (chars) => `"${repeatTo('  \r\n', chars)}x"`, false],
    ['control characters', (chars) => repeatTo('x\u0000\u0001', chars), false],
    ['lone surrogates', (chars) => repeatTo('x\ud800', chars), false],
  ];

  /** Shapes that are one caller-sized word: 1.25k → 80k. */
  const ONE_WORD: ReadonlyArray<readonly [string, (chars: number) => string, boolean]> = [
    ['nested openers inside a word', (chars) => repeatTo('(a', chars), false],
    ['closers inside a word', (chars) => repeatTo('a)', chars), false],
    ['a word of excluded openers', (chars) => repeatTo('-(', chars), true],
    ['a word of stars', (chars) => `x${repeatTo('*', chars)}`, false],
  ];

  for (const [label, build, rejected] of SHORT_TOKENS) {
    it(`stays linear on ${label} across a 64× span`, () => {
      expect(growth(build, rejected, 5_000)).toBeLessThan(256);
    }, 60_000);
  }

  for (const [label, build, rejected] of ONE_WORD) {
    it(`stays linear on ${label} across a 64× span`, () => {
      expect(growth(build, rejected, 1_250)).toBeLessThan(256);
    }, 60_000);
  }
});

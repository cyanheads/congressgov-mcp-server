/**
 * @fileoverview Tests for the CSV reader behind Voteview's files: RFC 4180 fields,
 * quoting, row endings, blank lines, the two malformed-input throws, and linear
 * cost on the inputs a re-scanning or backtracking reader turns quadratic on.
 * @module tests/services/senate-lis/csv.test
 */

import { describe, expect, it } from 'vitest';
import { readCsv } from '@/services/senate-lis/csv.js';
import { capturedFile } from './voteview-fixtures.js';

/** Every row `readCsv` reports, in order. */
function rows(text: string): string[][] {
  const out: string[][] = [];
  readCsv(text, (fields) => out.push(fields));
  return out;
}

describe('readCsv', () => {
  it('splits rows into fields', () => {
    expect(rows('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('reads a quoted field holding commas', () => {
    expect(rows('x,"a, b, c",y\n')).toEqual([['x', 'a, b, c', 'y']]);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(rows('"say ""hi""",z\n')).toEqual([['say "hi"', 'z']]);
    expect(rows('""""""\n')).toEqual([['""']]);
    expect(rows('"",a\n')).toEqual([['', 'a']]);
  });

  it('keeps line breaks inside a quoted field', () => {
    expect(rows('"line 1\nline 2","x\r\ny"\nnext\n')).toEqual([
      ['line 1\nline 2', 'x\r\ny'],
      ['next'],
    ]);
  });

  it('ends rows at LF, CRLF, or a lone CR', () => {
    expect(rows('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(rows('a\rb\n"c"\r\nd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('skips a leading byte order mark, and only a leading one', () => {
    expect(rows('﻿chamber,icpsr\nSenate,1\n')).toEqual([
      ['chamber', 'icpsr'],
      ['Senate', '1'],
    ]);
    expect(rows('a,﻿b')).toEqual([['a', '﻿b']]);
  });

  it('skips blank lines, LF and CRLF alike', () => {
    expect(rows('\n\na,b\n\n\r\n\r\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('reads a trailing comma as one last, empty field', () => {
    expect(rows('a,b,\nc,d,')).toEqual([
      ['a', 'b', ''],
      ['c', 'd', ''],
    ]);
    expect(rows(',,\n')).toEqual([['', '', '']]);
  });

  it('ends the last row at the end of the text, with or without a line break', () => {
    expect(rows('a,b')).toEqual([['a', 'b']]);
    expect(rows('a,b\n')).toEqual([['a', 'b']]);
    expect(rows('a,"b"')).toEqual([['a', 'b']]);
  });

  it('reports no rows for empty text', () => {
    expect(rows('')).toEqual([]);
    expect(rows('﻿')).toEqual([]);
    expect(rows('\r\n\n')).toEqual([]);
  });

  it('reads a quote inside an unquoted field as a literal character', () => {
    expect(rows('ab"c,d\n')).toEqual([['ab"c', 'd']]);
  });

  it('reads every captured Voteview file to its header width', () => {
    for (const congress of [101, 118, 119]) {
      for (const kind of ['rollcalls', 'votes', 'members']) {
        const read = rows(capturedFile(`S${congress}_${kind}.csv`));
        const width = read[0]?.length;
        expect(width, `S${congress}_${kind}`).toBeGreaterThan(5);
        expect(
          read.filter((fields) => fields.length !== width),
          `S${congress}_${kind}`,
        ).toEqual([]);
      }
    }
    /** A quoted description with commas, as Voteview writes it. */
    const rollcalls = rows(capturedFile('S119_rollcalls.csv'));
    const description = rollcalls[0]?.indexOf('vote_desc') as number;
    expect(rollcalls[1]?.[description]).toBe(
      'A bill to require the Secretary of Homeland Security to take into custody aliens who have been charged in the United States with theft, and for other purposes.',
    );
  });

  it('throws on a quoted field that never closes, naming where it opened', () => {
    expect(() => rows('"abc')).toThrow('CSV quoted field opened at offset 0 never closes.');
    expect(() => rows('x,"a""b\n')).toThrow('CSV quoted field opened at offset 2 never closes.');
  });

  it('throws on text after a closing quote, naming where it closed', () => {
    expect(() => rows('"abc"d,e')).toThrow(
      'CSV quoted field closed at offset 4 is followed by more text.',
    );
  });
});

/**
 * The reader makes one pass: unquoted fields by a forward scan, quoted ones by
 * jumps from quote to quote. These time it, in the thread's own CPU time, on
 * the inputs a reader that re-scans a field or the rest of the text turns quadratic on.
 */
describe('readCsv timing', () => {
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

  const ignoreRow = (): void => {};

  /** Read `text`; a shape built to be malformed must throw, and only with the reader's own error. */
  function read(text: string, malformed: boolean): void {
    try {
      readCsv(text, ignoreRow);
    } catch (error) {
      if (malformed && error instanceof Error && error.message.startsWith('CSV quoted field')) {
        return;
      }
      throw error;
    }
    if (malformed) throw new Error('expected the malformed text to throw');
  }

  /** CPU microseconds per character a linear reader stays well inside; a quadratic one at 20k is far outside. */
  const MICROS_PER_CHARACTER = 1;

  /**
   * Doubles from 5k to 320k characters, checking the absolute bound at each size
   * before building the next, so a quadratic regression fails in seconds.
   * Returns the per-call times.
   */
  function timeShape(build: (chars: number) => string, malformed: boolean): number[] {
    const perCall: number[] = [];
    for (let chars = 5_000; chars <= 320_000; chars *= 2) {
      const text = build(chars);
      /** ~640k characters per batch, so even the cheapest shape's batch spans far more than the timer's 1 µs resolution. */
      const batch = Math.max(1, Math.round(640_000 / text.length));
      const micros = leastCpuMicrosPerCall(() => read(text, malformed), batch);
      expect(micros, `${text.length} chars`).toBeLessThan(text.length * MICROS_PER_CHARACTER);
      perCall.push(micros);
    }
    return perCall;
  }

  const repeatTo = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

  const SHAPES: ReadonlyArray<readonly [string, (chars: number) => string, boolean]> = [
    ['one long line ending in a break', (chars) => `${repeatTo('abcdefg,', chars)}\n`, false],
    ['many line breaks', (chars) => repeatTo('\n', chars), false],
    ['many short CRLF rows', (chars) => repeatTo('a,b\r\n', chars), false],
    ['a field of doubled quotes', (chars) => `"${repeatTo('""', chars)}"\n`, false],
    ['many quoted fields', (chars) => repeatTo('"a,b",', chars), false],
    ['comma runs', (chars) => repeatTo(',', chars), false],
    ['an unterminated quote', (chars) => `"${repeatTo('x', chars)}`, true],
    ['an unterminated field of doubled quotes', (chars) => `"${repeatTo('""', chars)}`, true],
  ];

  for (const [label, build, malformed] of SHAPES) {
    it(`stays linear on ${label} across a 64× span`, () => {
      const perCall = timeShape(build, malformed);
      expect(perCall).toHaveLength(7);
      expect((perCall.at(-1) as number) / (perCall[0] as number)).toBeLessThan(256);
    }, 60_000);
  }
});

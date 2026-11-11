/**
 * @fileoverview Pure normalization helpers for the bill mirror — HTML→plain-text
 * stripping (summaries ship as HTML; the FTS index and snippet surface want plain
 * text) and the search query grammar's translation to an FTS5 `MATCH` expression
 * (every term individually quoted, every operator emitted by the translator, so
 * no caller text reaches FTS5 as query syntax). No I/O.
 * @module services/congress-mirror/normalize
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { decodeCharacterReferences } from '@/utils/character-references.js';

/**
 * Strip HTML tags to plain text and decode the character references Congress.gov
 * emits in summary bodies. Block-ish tags collapse to spaces so adjacent words
 * don't fuse (`</p><p>` → space), and whitespace is collapsed to single spaces —
 * a discovery/snippet surface doesn't need paragraph structure, and flat text
 * tokenizes more cleanly for FTS5.
 *
 * References decode in one pass, after the tags are gone, so text that literally
 * says `&amp;lt;` indexes as `&lt;` rather than as a tag the source never had.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    .replace(/<\s*br\s*\/?\s*>/gi, ' ')
    .replace(/<\s*\/?(p|div|li|ul|ol|h[1-6]|tr|table)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeCharacterReferences(text).replace(/\s+/g, ' ').trim();
}

/** A grouping or phrase mark the translation ignored because nothing paired with it. */
export type UnmatchedMark = '(' | ')' | '"';

/** How a query excluded something: the `NOT` operator, or a `-` at the start of a word, phrase, or group. */
export type ExclusionForm = 'NOT' | '-';

/** A search query translated to FTS5. */
export interface FtsQuery {
  /** Each exclusion form the translation applied, once, in the order the query first uses them. */
  exclusions: ExclusionForm[];
  /** The `MATCH` expression: every term double-quoted, every operator and parenthesis explicit. */
  match: string;
  /** Each unmatched mark the translation ignored, once, in the order the query first shows them. */
  unmatched: UnmatchedMark[];
}

/**
 * Deepest nesting of groups that change the result — a group that holds OR or
 * an exclusion, or is excluded. A group of one item, and a group of AND-joined
 * items with no exclusion that is not itself excluded, prints no parentheses of
 * its own and adds no level. FTS5's expression parser has a fixed stack, and
 * the most stack-hungry expression this translation emits per counted level
 * stays well inside it at this depth.
 */
export const MAX_GROUP_DEPTH = 10;

const QUOTE = 0x22;
const OPEN = 0x28;
const CLOSE = 0x29;
const STAR = 0x2a;
const MINUS = 0x2d;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

type Operator = 'AND' | 'OR' | 'NOT';

type Token =
  | { kind: 'term'; text: string; prefix: boolean; negated: boolean; start: number; end: number }
  | { kind: 'operator'; operator: Operator; start: number; end: number }
  /** `close` is the index of the matching close token, or -1 when nothing closes it. */
  | { kind: 'open'; negated: boolean; close: number; start: number; end: number }
  | { kind: 'close'; start: number; end: number };

/** One translated (sub)expression: a quoted term, or an operator over its operands. */
type Expr =
  | { kind: 'term'; text: string }
  | { kind: 'and' | 'or'; items: Expr[] }
  | { kind: 'not'; excluded: Expr; searched: Expr };

/**
 * Levels of counted groups (see {@link MAX_GROUP_DEPTH}) an operand nests, read
 * in each context its group can put it in: an AND group counts only once it is
 * excluded, and a one-item group passes its context on to its item.
 */
interface Levels {
  excluded: number;
  included: number;
}

const FLAT: Levels = { excluded: 0, included: 0 };

/** An operand with the source span the caller wrote for it. */
interface Operand {
  end: number;
  expr: Expr;
  levels: Levels;
  start: number;
}

/** The source span of a group's parentheses. */
interface Span {
  end: number;
  start: number;
}

/** How a finished group reaches the group around it. */
type Entry =
  /** As an operand of its own, excluded by its `-(` or by an ignored `-(` before it. */
  | { kind: 'operand'; negated: boolean; span: Span }
  /** As the operand of the NOT at `start`; `negated`, a `-` on it, leaves that NOT nothing to exclude. */
  | { kind: 'not'; negated: boolean; span: Span; start: number };

/** One group being translated: the whole query, or the tokens between a `(` and its `)`. */
interface Group {
  alternatives: Operand[][];
  /** Token index the group ends at: its `)`, or the token count for the whole query. */
  end: number;
  /** Null for the whole query. */
  entry: Entry | null;
  excluded: Operand[];
  /** Set by an unmatched `-(`: the exclusion carries to the operand after the ignored `(`. */
  negateNext: boolean;
  operandSincePending: boolean;
  pending: Operator | null;
}

/**
 * Whether the code unit at `i` separates terms: whitespace, a control character
 * (C0, DEL, C1 — NUL included, which FTS5 reads as the end of the query), or an
 * unpaired surrogate. A high surrogate followed by a low one is a character.
 */
function isSeparator(query: string, i: number): boolean {
  const code = query.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdfff) {
    return !(code <= 0xdbff && isLowSurrogate(query.charCodeAt(i + 1)));
  }
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0xa0) ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Code units the character at `i` spans: 2 for a surrogate pair, else 1. */
function widthAt(query: string, i: number): number {
  const code = query.charCodeAt(i);
  return code >= 0xd800 && code <= 0xdbff && isLowSurrogate(query.charCodeAt(i + 1)) ? 2 : 1;
}

/** `query[from, to)` with every separator turned into a space, so a phrase's words stay apart. */
function spacedText(query: string, from: number, to: number): string {
  let text = '';
  let piece = from;
  for (let i = from; i < to; i += widthAt(query, i)) {
    if (!isSeparator(query, i)) continue;
    text += `${query.slice(piece, i)} `;
    piece = i + 1;
  }
  return text + query.slice(piece, to);
}

/** Thrown for a query the grammar can't translate; the search tool declares the reason. */
function invalidQuery(message: string, literal?: string): never {
  throw validationError(
    message,
    { reason: 'invalid_query', retryable: false },
    literal ? { literals: [literal] } : undefined,
  );
}

function missingOperand(operator: Operator): never {
  return invalidQuery(
    operator === 'NOT'
      ? 'NOT needs a term after it to exclude, as in wildfire NOT smoke. Quote it ("NOT") to search for the word itself.'
      : `${operator} needs a term to search for on each side, as in wildfire ${operator} drought. Quote it ("${operator}") to search for the word itself.`,
  );
}

/**
 * Split a query into terms, operators, and group marks in one pass. Quotes pair
 * left to right; an odd last one is skipped as if absent (`don"t` reads `dont`).
 * A `(` opens a group only at the start of a word and a `)` closes one only at
 * its end, past any `(` inside the word it balances, so `501(c)(3)` and
 * `NEAR(wildfire` stay words. A `-` at the start of a word, or touching a phrase
 * or group, excludes it. A word with no letter or digit is dropped.
 */
function lex(query: string): { stray: number; tokens: Token[] } {
  let lastQuote = -1;
  let quotes = 0;
  for (let i = query.indexOf('"'); i !== -1; i = query.indexOf('"', i + 1)) {
    lastQuote = i;
    quotes++;
  }
  const stray = quotes % 2 === 1 ? lastQuote : -1;
  const tokens: Token[] = [];
  /** Where a lone `-` sits that excludes the phrase right after it, or -1. */
  let phraseNegation = -1;

  const pushWord = (from: number, to: number, spanStart: number, negated: boolean) => {
    let text =
      from <= stray && stray < to
        ? query.slice(from, stray) + query.slice(stray + 1, to)
        : query.slice(from, to);
    let stars = 0;
    while (stars < text.length && text.charCodeAt(text.length - 1 - stars) === STAR) stars++;
    if (stars > 0) text = text.slice(0, text.length - stars);
    if (!LETTER_OR_DIGIT.test(text)) return;
    if (!negated && stars === 0 && (text === 'AND' || text === 'OR' || text === 'NOT')) {
      tokens.push({ kind: 'operator', operator: text, start: from, end: to });
      return;
    }
    tokens.push({ kind: 'term', text, prefix: stars > 0, negated, start: spanStart, end: to });
  };

  const lexRun = (start: number, end: number, beforePhrase: boolean) => {
    let p = start;
    let negation = -1;
    for (;;) {
      while (p < end && query.charCodeAt(p) === OPEN) {
        tokens.push({ kind: 'open', negated: false, close: -1, start: p, end: p + 1 });
        p++;
      }
      if (p >= end || query.charCodeAt(p) !== MINUS) break;
      if (p + 1 === end) {
        if (!beforePhrase) break;
        phraseNegation = p;
        return;
      }
      if (query.charCodeAt(p + 1) !== OPEN) {
        negation = p;
        p++;
        break;
      }
      tokens.push({ kind: 'open', negated: true, close: -1, start: p, end: p + 2 });
      p += 2;
    }
    let trailing = 0;
    while (end - trailing > p && query.charCodeAt(end - trailing - 1) === CLOSE) trailing++;
    let inner = 0;
    for (let k = p; k < end - trailing; k++) {
      const code = query.charCodeAt(k);
      if (code === OPEN) inner++;
      else if (code === CLOSE && inner > 0) inner--;
    }
    const wordEnd = end - (trailing - Math.min(inner, trailing));
    if (wordEnd > p) pushWord(p, wordEnd, negation === -1 ? p : negation, negation !== -1);
    for (let k = wordEnd; k < end; k++) {
      tokens.push({ kind: 'close', start: k, end: k + 1 });
    }
  };

  let i = 0;
  while (i < query.length) {
    if (isSeparator(query, i) || i === stray) {
      i++;
      continue;
    }
    if (query.charCodeAt(i) === QUOTE) {
      /** Not the stray quote, so the next quote is its partner. */
      const close = query.indexOf('"', i + 1);
      const text = spacedText(query, i + 1, close);
      const negated = phraseNegation !== -1;
      if (LETTER_OR_DIGIT.test(text)) {
        tokens.push({
          kind: 'term',
          text,
          prefix: false,
          negated,
          start: negated ? phraseNegation : i,
          end: close + 1,
        });
      }
      phraseNegation = -1;
      i = close + 1;
      continue;
    }
    phraseNegation = -1;
    let end = i;
    while (
      end < query.length &&
      !isSeparator(query, end) &&
      (query.charCodeAt(end) !== QUOTE || end === stray)
    ) {
      end += widthAt(query, end);
    }
    lexRun(i, end, end < query.length && query.charCodeAt(end) === QUOTE);
    i = end;
  }
  return { stray, tokens };
}

/** Note `key` at query position `at`, keeping the earliest position noted for it. */
function noteFirst<K>(firsts: Map<K, number>, key: K, at: number): void {
  const noted = firsts.get(key);
  if (noted === undefined || at < noted) firsts.set(key, at);
}

/** The noted keys, earliest position first. */
function inQueryOrder<K>(firsts: ReadonlyMap<K, number>): K[] {
  return [...firsts].sort((a, b) => a[1] - b[1]).map(([key]) => key);
}

/** Operands under one operator, or the operand itself when there is one. */
function join(kind: 'and' | 'or', items: Expr[]): Expr {
  return items.length === 1 ? (items[0] as Expr) : { kind, items };
}

/**
 * Write `root` as FTS5 text, parenthesizing a child only where its own top
 * operator differs from its parent's, so nested AND groups print as one AND
 * chain. Every AND is written out: FTS5 rejects an implicit AND before a
 * parenthesis. Each node is visited once.
 */
function write(root: Expr): string {
  const parts: string[] = [];
  /** What is left to write, last first: an expression or literal text. */
  const work: (Expr | string)[] = [root];
  const push = (child: Expr, bare: boolean) => {
    if (bare) work.push(child);
    else work.push(')', child, '(');
  };
  for (let next = work.pop(); next !== undefined; next = work.pop()) {
    if (typeof next === 'string') parts.push(next);
    else if (next.kind === 'term') parts.push(next.text);
    else if (next.kind === 'not') {
      push(next.excluded, next.excluded.kind === 'term');
      work.push(' NOT ');
      push(next.searched, next.searched.kind === 'term');
    } else {
      const glue = next.kind === 'and' ? ' AND ' : ' OR ';
      for (let i = next.items.length - 1; i >= 0; i--) {
        const item = next.items[i] as Expr;
        push(item, item.kind === 'term' || item.kind === next.kind);
        if (i > 0) work.push(glue);
      }
    }
  }
  return parts.join('');
}

/** The counted levels of a group whose included alternatives and exclusions are these. */
function levelsOf(included: readonly Operand[][], excluded: readonly Operand[]): Levels {
  const [only] = included;
  if (excluded.length === 0 && included.length === 1 && only) {
    if (only.length === 1) return (only[0] as Operand).levels;
    let deepest = 0;
    for (const operand of only) deepest = Math.max(deepest, operand.levels.included);
    return { excluded: deepest + 1, included: deepest };
  }
  let deepest = 0;
  for (const alternative of included) {
    for (const operand of alternative) deepest = Math.max(deepest, operand.levels.included);
  }
  for (const operand of excluded) deepest = Math.max(deepest, operand.levels.excluded);
  return { excluded: deepest + 1, included: deepest + 1 };
}

function tooDeep(): never {
  return invalidQuery(
    `The query nests groups that hold OR or an exclusion, or are excluded, more than ${MAX_GROUP_DEPTH} levels deep. Flatten some of those groups.`,
  );
}

function openGroup(end: number, entry: Entry | null): Group {
  return {
    alternatives: [[]],
    end,
    entry,
    excluded: [],
    negateNext: false,
    operandSincePending: false,
    pending: null,
  };
}

/** Record an operand in `group`: an exclusion, a new OR alternative, or one more AND-joined item. */
function add(group: Group, operand: Operand, negated: boolean): void {
  if (group.pending === 'OR' && negated) missingOperand('OR');
  if (negated) group.excluded.push(operand);
  else if (group.pending === 'OR') group.alternatives.push([operand]);
  else group.alternatives.at(-1)?.push(operand);
  group.pending = null;
  group.operandSincePending = true;
}

/**
 * Close `group`. Its included items AND together, `OR` separates alternatives,
 * and its exclusions follow as one `NOT (a OR b …)`, so the expression grows no
 * deeper however many terms it excludes. Returns null for a group with nothing
 * in it to search.
 */
function closeGroup(query: string, group: Group): { expr: Expr; levels: Levels } | null {
  if (group.pending) missingOperand(group.pending);
  const included = group.alternatives.filter((alternative) => alternative.length > 0);
  const first = group.excluded[0];
  if (included.length === 0) {
    if (!first) return null;
    const token = query.slice(first.start, first.end);
    if (group.entry) {
      invalidQuery(
        `The group ${query.slice(group.entry.span.start, group.entry.span.end)} has no term to search for: ${token} only excludes. Add a term to search for inside the group, or move ${token} out of it.`,
        token,
      );
    }
    invalidQuery(
      `The query has no term to search for: ${token} only excludes. Add a term to search for beside it, as in wildfire ${token}.`,
      token,
    );
  }
  const searched = join(
    'or',
    included.map((alternative) =>
      join(
        'and',
        alternative.map((operand) => operand.expr),
      ),
    ),
  );
  return {
    expr: first
      ? {
          kind: 'not',
          searched,
          excluded: join(
            'or',
            group.excluded.map((operand) => operand.expr),
          ),
        }
      : searched,
    levels: levelsOf(included, group.excluded),
  };
}

/** A term token as an operand: quoted, with its prefix `*`. */
function termOperand(token: Extract<Token, { kind: 'term' }>): Operand {
  return {
    expr: { kind: 'term', text: `"${token.text}"${token.prefix ? '*' : ''}` },
    levels: FLAT,
    start: token.start,
    end: token.end,
  };
}

/** The span of the group a matched `(` opens. */
function spanOf(tokens: readonly Token[], open: Extract<Token, { kind: 'open' }>): Span {
  return { start: open.start, end: (tokens[open.close] as Token).end };
}

/**
 * Translate the tokens to one expression, or null when nothing in them is
 * searched, one token at a time: each group is opened at its `(`, closed at its
 * `)`, and handed to the group around it with the levels it counts, refused
 * once those pass {@link MAX_GROUP_DEPTH}. Groups that add no level nest
 * without limit. Each exclusion applied is noted in `exclusions` under its form,
 * at the query position of its `NOT` or `-`.
 */
function translate(
  query: string,
  tokens: readonly Token[],
  exclusions: Map<ExclusionForm, number>,
): Expr | null {
  const groups: Group[] = [openGroup(tokens.length, null)];
  let k = 0;
  for (;;) {
    const group = groups.at(-1) as Group;
    if (k === group.end) {
      const closed = closeGroup(query, group);
      groups.pop();
      const around = groups.at(-1);
      const { entry } = group;
      if (!around || !entry) return closed?.expr ?? null;
      if (entry.kind === 'not' && (!closed || entry.negated)) missingOperand('NOT');
      if (closed) {
        const negated = entry.kind === 'not' || entry.negated;
        if ((negated ? closed.levels.excluded : closed.levels.included) > MAX_GROUP_DEPTH) {
          tooDeep();
        }
        const start = entry.kind === 'not' ? entry.start : entry.span.start;
        add(around, { ...closed, start, end: entry.span.end }, negated);
        if (negated) noteFirst(exclusions, entry.kind === 'not' ? 'NOT' : '-', start);
      }
      k = group.end + 1;
      continue;
    }
    const token = tokens[k] as Token;
    if (token.kind === 'close' || (token.kind === 'open' && token.close === -1)) {
      if (token.kind === 'open' && token.negated) group.negateNext = true;
      k++;
      continue;
    }
    if (token.kind === 'operator') {
      group.negateNext = false;
      if (token.operator === 'NOT') {
        let next = k + 1;
        let negated = false;
        for (; next < group.end; next++) {
          const skipped = tokens[next] as Token;
          if (skipped.kind === 'open' && skipped.close === -1) negated ||= skipped.negated;
          else if (skipped.kind !== 'close') break;
        }
        const operand = next < group.end ? tokens[next] : undefined;
        if (operand?.kind === 'term') {
          if (operand.negated || negated) missingOperand('NOT');
          add(group, { ...termOperand(operand), start: token.start }, true);
          noteFirst(exclusions, 'NOT', token.start);
        } else if (operand?.kind === 'open') {
          groups.push(
            openGroup(operand.close, {
              kind: 'not',
              negated: negated || operand.negated,
              span: spanOf(tokens, operand),
              start: token.start,
            }),
          );
        } else missingOperand('NOT');
        k = next + 1;
        continue;
      }
      if (group.pending) missingOperand(group.pending);
      if (
        !group.operandSincePending ||
        (token.operator === 'OR' && group.alternatives.at(-1)?.length === 0)
      ) {
        missingOperand(token.operator);
      }
      group.pending = token.operator;
      group.operandSincePending = false;
      k++;
      continue;
    }
    /** Every other token kind was handled above, so a term or matched `(` starts here. */
    if (token.kind === 'term') {
      const negated = token.negated || group.negateNext;
      add(group, termOperand(token), negated);
      if (negated) noteFirst(exclusions, '-', token.start);
    } else {
      groups.push(
        openGroup(token.close, {
          kind: 'operand',
          negated: token.negated || group.negateNext,
          span: spanOf(tokens, token),
        }),
      );
    }
    group.negateNext = false;
    k++;
  }
}

/**
 * Translate a search query to an FTS5 `MATCH` expression. The grammar: words
 * AND together; `"two words"` is a phrase; `word*` a prefix; `-word` or
 * `NOT word` excludes from its group; `A OR B` takes either; `( … )` groups.
 * Only uppercase `AND`/`OR`/`NOT` are operators — `or`, `NEAR`, `title:x`, and a
 * quoted `"OR"` are searched as words. Whitespace, control characters, and
 * unpaired surrogates separate terms. An unmatched `(`, `)`, or `"` is ignored
 * and reported in `unmatched`; each exclusion form the query used is reported
 * in `exclusions`.
 *
 * @throws McpError `ValidationError`, `data.reason: 'invalid_query'`, naming the
 * token, for a query with no term to search for, an operator missing an operand,
 * or groups that change the result nested past {@link MAX_GROUP_DEPTH} — before
 * any SQL runs, so no input reaches SQLite as an FTS5 syntax error.
 */
export function toFtsMatch(query: string): FtsQuery {
  const { stray, tokens } = lex(query);
  const marks = new Map<UnmatchedMark, number>();

  const opens: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === 'open') opens.push(index);
    else if (token.kind === 'close') {
      const open = opens.pop();
      if (open === undefined) noteFirst(marks, ')', token.start);
      else (tokens[open] as Extract<Token, { kind: 'open' }>).close = index;
    }
  });
  if (opens.length > 0) noteFirst(marks, '(', (tokens[opens[0] as number] as Token).start);
  if (stray !== -1) noteFirst(marks, '"', stray);

  const exclusions = new Map<ExclusionForm, number>();
  const expr = translate(query, tokens, exclusions);
  if (!expr) {
    invalidQuery(
      'The query has no term to search for. Search with at least one word that holds a letter or digit.',
    );
  }
  return {
    exclusions: inQueryOrder(exclusions),
    match: write(expr),
    unmatched: inQueryOrder(marks),
  };
}

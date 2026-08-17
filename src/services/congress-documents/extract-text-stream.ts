/**
 * @fileoverview Incremental form of {@link extractDocumentText} — consumes a
 * document body chunk by chunk and retains only the requested character window.
 *
 * `extract-text.ts` is the normative definition of the extraction: every
 * character offset in the `content` contract indexes into the string it
 * produces. This module reproduces that string exactly while holding constant
 * memory, so a document is bounded by how long it takes to stream rather than by
 * how much of it fits in a buffer. The two are pinned against each other by a
 * differential test — if this file drifts, that test fails, not production.
 *
 * The whole-string pipeline is `normalize newlines → strip comments → unwrap
 * <pre> → strip tags → decode entities → trim`, and three of those stages are
 * decided by content that arrives arbitrarily late:
 *
 * - **Is there a `<pre>` at all?** Only a body with none is read whole. Both
 *   readings run at once, in two sinks; the losing one is dropped the moment a
 *   `<pre>` open tag settles the question.
 * - **Where is the last `</pre>`?** Every close is a candidate, so each one
 *   records a mark on the `<pre>` sink and the last mark standing is restored at
 *   end of stream.
 * - **Does this `<!--` (or this `<`) ever close?** An unterminated one is not a
 *   comment or a tag at all — the regexes leave it in the text. Its content is
 *   therefore written through as literal text and rolled back if the closing
 *   delimiter turns up.
 *
 * Every one of those rewinds is a mark: a handful of counters plus a length to
 * truncate the captured window to. Nothing rewindable grows with the document.
 *
 * @module services/congress-documents/extract-text-stream
 */

import { decodeCharacterReference } from './extract-text.js';

/** The character window to retain while streaming. */
export interface TextWindowRequest {
  /** Maximum characters to keep, counted from `characterOffset`. */
  characterLimit: number;
  /** First character of the extracted text to keep, 0-based. */
  characterOffset: number;
}

/** The retained window plus the length of the whole extracted text. */
export interface ExtractedWindow {
  /** The requested window of the extracted text. */
  text: string;
  /** Characters in the whole extracted document, not this window. */
  totalCharacters: number;
}

/** Consumes a document body in chunks and yields one character window. */
export interface StreamingExtractor {
  /** Finish the document and return its window. Call once, after the last push. */
  finish(): ExtractedWindow;
  /** Feed the next decoded chunk of the body. */
  push(chunk: string): void;
}

/**
 * Whitespace as `String.prototype.trim` defines it — WhiteSpace plus
 * LineTerminator, which is also exactly the `\s` character class.
 */
function isWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  if (code < 0x80) return false;
  return (
    code === 0xa0 ||
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

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

/** Stages of a `&…;` candidate, mirroring the alternatives in `ENTITY_RE`. */
const ENTITY_NONE = 0;
const ENTITY_AMP = 1;
const ENTITY_NAMED = 2;
const ENTITY_HASH = 3;
const ENTITY_HEX_MARKER = 4;
const ENTITY_DEC = 5;
const ENTITY_HEX = 6;

/**
 * The longest name any recognized entity has is four letters, so a longer run
 * resolves to nothing and renders verbatim whether or not it is ever closed.
 */
const MAX_ENTITY_NAME = 8;

/** The largest code point a numeric reference can name. */
const MAX_CODE_POINT = 0x10ffff;

/** A rewind point for one sink. Fixed size, whatever the document does. */
interface SinkMark {
  emitted: number;
  entityDigits: string;
  entityHexMarker: string;
  entityKind: number;
  entityName: string;
  entityZeros: number;
  inTag: boolean;
  started: boolean;
  tagMark: SinkMark | null;
  trailingWs: number;
  /** Set only by {@link WindowSink.protect} — see the note there. */
  windowCopy?: readonly string[];
  windowLength: number;
}

/**
 * One reading of the body: strips tags, decodes entities, trims, and keeps only
 * the characters inside the requested window.
 *
 * Two of these run in parallel — one fed from the start of the body, one fed
 * from just past a `<pre>` open tag — because tag and entity state differ
 * between the two readings (an entity can span a tag the `<pre>` slice cuts
 * away). Whichever reading the document turns out to be is the one that answers.
 */
class WindowSink {
  private emitted = 0;
  private entityDigits = '';
  private entityHexMarker = '';
  private entityKind = ENTITY_NONE;
  private entityName = '';
  private entityZeros = 0;
  private inTag = false;
  private started = false;
  private tagMark: SinkMark | null = null;
  private trailingWs = 0;
  private readonly windowChars: string[] = [];
  private readonly windowEnd: number;

  constructor(
    private readonly windowStart: number,
    windowLimit: number,
  ) {
    this.windowEnd = windowStart + windowLimit;
  }

  write(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (this.started && !this.inTag && this.entityKind === ENTITY_NONE) {
        let stop = i;
        while (stop < text.length) {
          const ch = text[stop] as string;
          if (ch === '<' || ch === '&' || isWhitespace(ch)) break;
          stop++;
        }
        if (stop > i) {
          this.emitRun(text, i, stop);
          i = stop;
          continue;
        }
      }
      this.writeChar(text[i] as string);
      i++;
    }
  }

  mark(): SinkMark {
    return {
      emitted: this.emitted,
      entityDigits: this.entityDigits,
      entityHexMarker: this.entityHexMarker,
      entityKind: this.entityKind,
      entityName: this.entityName,
      entityZeros: this.entityZeros,
      inTag: this.inTag,
      started: this.started,
      tagMark: this.tagMark,
      trailingWs: this.trailingWs,
      windowLength: this.windowChars.length,
    };
  }

  /**
   * Keep a mark restorable across a rewind that would land beneath it.
   *
   * Captured window characters are dropped by truncation, so a mark can only be
   * restored while nothing has rewound past it. A mark taken outside a tag is
   * safe by construction — every later rewind targets a `<` or a `<!--` at or
   * after it. One taken *inside* an open tag is not: that tag started earlier,
   * and the `>` closing it rewinds all the way back there. Only such a mark pays
   * for a copy of its window, taken while its characters are still intact.
   */
  protect(mark: SinkMark): SinkMark {
    if (!mark.inTag) return mark;
    return { ...mark, windowCopy: this.windowChars.slice(0, mark.windowLength) };
  }

  /** A mark that survives whatever the characters after it do. */
  protectedMark(): SinkMark {
    return this.protect(this.mark());
  }

  restore(mark: SinkMark): void {
    this.emitted = mark.emitted;
    this.entityDigits = mark.entityDigits;
    this.entityHexMarker = mark.entityHexMarker;
    this.entityKind = mark.entityKind;
    this.entityName = mark.entityName;
    this.entityZeros = mark.entityZeros;
    this.inTag = mark.inTag;
    this.started = mark.started;
    this.tagMark = mark.tagMark;
    this.trailingWs = mark.trailingWs;
    this.windowChars.length = mark.windowLength;
    if (mark.windowCopy !== undefined) {
      for (let i = 0; i < mark.windowCopy.length; i++) {
        this.windowChars[i] = mark.windowCopy[i] as string;
      }
    }
  }

  /**
   * An open tag or entity candidate still pending at end of stream never closed,
   * so it is text, not markup — the same reading the regexes give it.
   */
  finish(): ExtractedWindow {
    this.flushEntityVerbatim();
    const totalCharacters = this.emitted - this.trailingWs;
    const overshoot = this.windowStart + this.windowChars.length - totalCharacters;
    const take = overshoot > 0 ? this.windowChars.length - overshoot : this.windowChars.length;
    return {
      text: take > 0 ? this.windowChars.slice(0, take).join('') : '',
      totalCharacters,
    };
  }

  private writeChar(ch: string): void {
    if (this.inTag) {
      /** `<[^>]*>` ends at the first `>`; everything it spanned was markup. */
      if (ch === '>') {
        this.restore(this.tagMark as SinkMark);
        return;
      }
      this.literal(ch);
      return;
    }
    if (ch === '<') {
      this.tagMark = this.mark();
      this.inTag = true;
      this.literal(ch);
      return;
    }
    this.literal(ch);
  }

  /** Feed one character to the entity decoder. */
  private literal(ch: string): void {
    if (this.entityKind !== ENTITY_NONE && this.stepEntity(ch)) return;
    if (ch === '&') {
      this.entityKind = ENTITY_AMP;
      return;
    }
    this.emitChar(ch);
  }

  /** Advance the entity candidate. Returns false when `ch` still needs handling. */
  private stepEntity(ch: string): boolean {
    switch (this.entityKind) {
      case ENTITY_AMP:
        if (ch === '#') {
          this.entityKind = ENTITY_HASH;
          return true;
        }
        if (isAsciiLetter(ch)) {
          this.entityKind = ENTITY_NAMED;
          this.entityName = ch;
          return true;
        }
        break;
      case ENTITY_NAMED:
        if (isAsciiLetter(ch)) {
          this.entityName += ch;
          if (this.entityName.length > MAX_ENTITY_NAME) this.flushEntityVerbatim();
          return true;
        }
        if (ch === ';') {
          this.completeEntity(this.entityName);
          return true;
        }
        break;
      case ENTITY_HASH:
        if (ch === 'x' || ch === 'X') {
          this.entityKind = ENTITY_HEX_MARKER;
          this.entityHexMarker = ch;
          return true;
        }
        if (isDigit(ch)) {
          this.entityKind = ENTITY_DEC;
          this.addEntityDigit(ch, false);
          return true;
        }
        break;
      case ENTITY_HEX_MARKER:
        if (isHexDigit(ch)) {
          this.entityKind = ENTITY_HEX;
          this.addEntityDigit(ch, true);
          return true;
        }
        break;
      case ENTITY_DEC:
        if (isDigit(ch)) {
          this.addEntityDigit(ch, false);
          return true;
        }
        if (ch === ';') {
          this.completeEntity(`#${this.significantDigits()}`);
          return true;
        }
        break;
      case ENTITY_HEX:
        if (isHexDigit(ch)) {
          this.addEntityDigit(ch, true);
          return true;
        }
        if (ch === ';') {
          this.completeEntity(`#${this.entityHexMarker}${this.significantDigits()}`);
          return true;
        }
        break;
    }
    this.flushEntityVerbatim();
    return false;
  }

  /**
   * Leading zeros are counted rather than stored, so a reference padded to any
   * width still resolves without buffering it. Past the largest code point the
   * value can only climb, so the reference is already text.
   */
  private addEntityDigit(ch: string, hex: boolean): void {
    if (this.entityDigits === '' && ch === '0') {
      this.entityZeros++;
      return;
    }
    this.entityDigits += ch;
    if (Number.parseInt(this.entityDigits, hex ? 16 : 10) > MAX_CODE_POINT) {
      this.flushEntityVerbatim();
    }
  }

  private significantDigits(): string {
    return this.entityDigits === '' ? '0' : this.entityDigits;
  }

  private completeEntity(ref: string): void {
    const decoded = decodeCharacterReference(ref);
    if (decoded === undefined) {
      this.flushEntityVerbatim();
      this.emitChar(';');
      return;
    }
    this.entityKind = ENTITY_NONE;
    this.entityName = '';
    this.entityDigits = '';
    this.entityHexMarker = '';
    this.entityZeros = 0;
    this.emit(decoded);
  }

  /** Render the pending candidate as the literal characters it was built from. */
  private flushEntityVerbatim(): void {
    const kind = this.entityKind;
    if (kind === ENTITY_NONE) return;
    const name = this.entityName;
    const digits = this.entityDigits;
    const hexMarker = this.entityHexMarker;
    const zeros = this.entityZeros;
    this.entityKind = ENTITY_NONE;
    this.entityName = '';
    this.entityDigits = '';
    this.entityHexMarker = '';
    this.entityZeros = 0;

    this.emitChar('&');
    if (kind === ENTITY_NAMED) {
      this.emit(name);
      return;
    }
    if (kind === ENTITY_AMP) return;
    this.emitChar('#');
    if (kind === ENTITY_HEX_MARKER || kind === ENTITY_HEX) this.emitChar(hexMarker);
    for (let i = 0; i < zeros; i++) this.emitChar('0');
    if (digits !== '') this.emit(digits);
  }

  private emit(text: string): void {
    for (let i = 0; i < text.length; i++) this.emitChar(text[i] as string);
  }

  private emitChar(ch: string): void {
    if (!this.started) {
      if (isWhitespace(ch)) return;
      this.started = true;
    }
    const index = this.emitted;
    this.emitted = index + 1;
    if (isWhitespace(ch)) this.trailingWs++;
    else this.trailingWs = 0;
    if (index >= this.windowStart && index < this.windowEnd) this.windowChars.push(ch);
  }

  /** Bulk path for a run with no markup, no entity, and no whitespace in it. */
  private emitRun(text: string, from: number, to: number): void {
    const start = this.emitted;
    this.emitted = start + (to - from);
    this.trailingWs = 0;
    if (start >= this.windowEnd || this.emitted <= this.windowStart) return;
    const sliceFrom = Math.max(from, from + (this.windowStart - start));
    const sliceTo = Math.min(to, from + (this.windowEnd - start));
    for (let i = sliceFrom; i < sliceTo; i++) this.windowChars.push(text[i] as string);
  }
}

/** Everything a comment rollback has to put back. */
interface Checkpoint {
  closeMark: SinkMark | null;
  closeStart: number;
  closeState: number;
  lastCloseMark: SinkMark | null;
  noPreMark: SinkMark;
  openState: number;
  position: number;
  preMark: SinkMark | null;
  preStart: number;
}

/** `<\s*pre(?:\s[^>]*)?\/?>` as a state machine. `-1` is "already matched". */
const OPEN_DONE = -1;
const OPEN_IDLE = 0;
const OPEN_AFTER_LT = 1;
const OPEN_P = 2;
const OPEN_PR = 3;
const OPEN_PRE = 4;
const OPEN_SLASH = 5;
const OPEN_ATTRS = 6;

/** `<\s*\/\s*pre\s*>` as a state machine. */
const CLOSE_IDLE = 0;
const CLOSE_AFTER_LT = 1;
const CLOSE_SLASH = 2;
const CLOSE_P = 3;
const CLOSE_PR = 4;
const CLOSE_PRE = 5;

class DocumentTextStream implements StreamingExtractor {
  private carry = '';
  private checkpoint: Checkpoint | null = null;
  private closeMark: SinkMark | null = null;
  private closeStart = 0;
  private closeState = CLOSE_IDLE;
  private inComment = false;
  private lastCloseMark: SinkMark | null = null;
  private readonly noPre: WindowSink;
  private openState = OPEN_IDLE;
  private pendingCr = false;
  private pendingMark: SinkMark | null = null;
  private pendingMarkPosition = 0;
  private position = 0;
  private pre: WindowSink | null = null;
  private preDecided = false;
  private preStart = 0;
  private readonly windowLimit: number;
  private readonly windowStart: number;

  constructor(request: TextWindowRequest) {
    this.windowStart = request.characterOffset;
    this.windowLimit = request.characterLimit;
    this.noPre = new WindowSink(this.windowStart, this.windowLimit);
  }

  push(chunk: string): void {
    if (chunk !== '') this.consume(this.normalizeNewlines(chunk));
  }

  finish(): ExtractedWindow {
    if (this.pendingCr) {
      this.pendingCr = false;
      this.consume('\n');
    }
    if (this.carry !== '') {
      const rest = this.carry;
      this.carry = '';
      this.feed(rest);
    }
    if (this.pre !== null && this.lastCloseMark !== null) this.pre.restore(this.lastCloseMark);
    return (this.pre ?? this.noPre).finish();
  }

  /** `\r\n?` → `\n`, holding a trailing `\r` until the next chunk resolves it. */
  private normalizeNewlines(chunk: string): string {
    let text = chunk;
    if (this.pendingCr) {
      this.pendingCr = false;
      text = `\n${text.startsWith('\n') ? text.slice(1) : text}`;
    }
    if (text.endsWith('\r')) {
      this.pendingCr = true;
      text = text.slice(0, -1);
    }
    return text.replace(/\r\n?/g, '\n');
  }

  /**
   * `<!--[\s\S]*?-->` removal. A comment's content is written through as literal
   * text and rolled back once `-->` arrives, because an unterminated `<!--` is
   * not a comment — the regex matches nothing and leaves it in the document.
   */
  private consume(chunk: string): void {
    const text = this.carry + chunk;
    this.carry = '';
    let i = 0;
    while (i < text.length) {
      if (this.inComment) {
        const end = text.indexOf('-->', i);
        if (end === -1) {
          const safe = Math.max(i, text.length - 2);
          this.feed(text.slice(i, safe));
          this.carry = text.slice(safe);
          return;
        }
        this.feed(text.slice(i, end + 3));
        this.restoreCheckpoint();
        this.inComment = false;
        i = end + 3;
        continue;
      }
      const at = text.indexOf('<!--', i);
      if (at === -1) {
        const safe = Math.max(i, text.length - 3);
        this.feed(text.slice(i, safe));
        this.carry = text.slice(safe);
        return;
      }
      this.feed(text.slice(i, at));
      this.checkpoint = this.captureCheckpoint();
      this.inComment = true;
      /** `[\s\S]*?` may match nothing, but never the opener's own dashes. */
      this.feed(text.slice(at, at + 4));
      i = at + 4;
    }
  }

  /** Drive the sinks and the `<pre>` scanners over comment-stripped text. */
  private feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (this.openState <= OPEN_IDLE && this.closeState === CLOSE_IDLE) {
        const next = text.indexOf('<', i);
        const stop = next === -1 ? text.length : next;
        if (stop > i) {
          this.writeSinks(text.slice(i, stop));
          this.position += stop - i;
          i = stop;
          continue;
        }
      }
      const ch = text[i] as string;
      /**
       * The `<pre>` sink is read at three different moments in one character:
       * a close candidate marks it before the `<` lands, a confirmed close
       * protects it before the `>` lands (closing that `>` can rewind the sink),
       * and an opening tag creates it only after the `>` has gone by.
       */
      if (this.pre !== null && ch === '<') {
        this.pendingMark = this.pre.mark();
        this.pendingMarkPosition = this.position;
      }
      this.stepPreClose(ch);
      this.writeSinks(ch);
      this.stepPreOpen(ch);
      this.position++;
      i++;
    }
  }

  private writeSinks(text: string): void {
    if (!this.preDecided) this.noPre.write(text);
    this.pre?.write(text);
  }

  /**
   * The leftmost `<pre>` opens the slice the rest of the pipeline reads. Until
   * one turns up the document may have none at all, so the whole-body reading
   * runs alongside; a match outside a comment settles it and retires that sink.
   */
  private stepPreOpen(ch: string): void {
    switch (this.openState) {
      case OPEN_DONE:
        return;
      case OPEN_IDLE:
        this.openState = ch === '<' ? OPEN_AFTER_LT : OPEN_IDLE;
        return;
      case OPEN_AFTER_LT:
        if (isWhitespace(ch)) return;
        if (ch === 'p' || ch === 'P') this.openState = OPEN_P;
        else this.openState = ch === '<' ? OPEN_AFTER_LT : OPEN_IDLE;
        return;
      case OPEN_P:
        this.openState = ch === 'r' || ch === 'R' ? OPEN_PR : this.restartOpen(ch);
        return;
      case OPEN_PR:
        this.openState = ch === 'e' || ch === 'E' ? OPEN_PRE : this.restartOpen(ch);
        return;
      case OPEN_PRE:
        if (ch === '>') this.openPre();
        else if (ch === '/') this.openState = OPEN_SLASH;
        else if (isWhitespace(ch)) this.openState = OPEN_ATTRS;
        else this.openState = this.restartOpen(ch);
        return;
      case OPEN_SLASH:
        if (ch === '>') this.openPre();
        else this.openState = this.restartOpen(ch);
        return;
      default:
        /** `[^>]*` swallows everything, `<` included, up to the closing `>`. */
        if (ch === '>') this.openPre();
        return;
    }
  }

  private restartOpen(ch: string): number {
    return ch === '<' ? OPEN_AFTER_LT : OPEN_IDLE;
  }

  private openPre(): void {
    this.openState = OPEN_DONE;
    this.preStart = this.position + 1;
    this.pre = new WindowSink(this.windowStart, this.windowLimit);
    if (!this.inComment) this.preDecided = true;
  }

  /**
   * Every `</pre>` past the opening tag is a candidate for the last one, so each
   * records where the `<pre>` sink stood before it. End of stream restores the
   * survivor, which is exactly the slice ending at the last `</pre>`.
   */
  private stepPreClose(ch: string): void {
    if (this.pre === null) return;
    switch (this.closeState) {
      case CLOSE_IDLE:
        if (ch === '<') this.startCloseCandidate();
        return;
      case CLOSE_AFTER_LT:
        if (isWhitespace(ch)) return;
        if (ch === '/') this.closeState = CLOSE_SLASH;
        else this.restartClose(ch);
        return;
      case CLOSE_SLASH:
        if (isWhitespace(ch)) return;
        if (ch === 'p' || ch === 'P') this.closeState = CLOSE_P;
        else this.restartClose(ch);
        return;
      case CLOSE_P:
        if (ch === 'r' || ch === 'R') this.closeState = CLOSE_PR;
        else this.restartClose(ch);
        return;
      case CLOSE_PR:
        if (ch === 'e' || ch === 'E') this.closeState = CLOSE_PRE;
        else this.restartClose(ch);
        return;
      default:
        if (isWhitespace(ch)) return;
        if (ch === '>') {
          if (this.closeStart > this.preStart && this.closeMark !== null) {
            this.lastCloseMark = this.pre.protect(this.closeMark);
          }
          this.closeState = CLOSE_IDLE;
          return;
        }
        this.restartClose(ch);
    }
  }

  private startCloseCandidate(): void {
    this.closeState = CLOSE_AFTER_LT;
    this.closeMark = this.pendingMark;
    this.closeStart = this.pendingMarkPosition;
  }

  private restartClose(ch: string): void {
    if (ch === '<') this.startCloseCandidate();
    else this.closeState = CLOSE_IDLE;
  }

  private captureCheckpoint(): Checkpoint {
    return {
      closeMark: this.closeMark,
      closeStart: this.closeStart,
      closeState: this.closeState,
      lastCloseMark: this.lastCloseMark,
      noPreMark: this.noPre.protectedMark(),
      openState: this.openState,
      position: this.position,
      preMark: this.pre?.protectedMark() ?? null,
      preStart: this.preStart,
    };
  }

  private restoreCheckpoint(): void {
    const saved = this.checkpoint as Checkpoint;
    this.checkpoint = null;
    this.noPre.restore(saved.noPreMark);
    if (saved.preMark === null) this.pre = null;
    else this.pre?.restore(saved.preMark);
    this.closeMark = saved.closeMark;
    this.closeStart = saved.closeStart;
    this.closeState = saved.closeState;
    this.lastCloseMark = saved.lastCloseMark;
    this.openState = saved.openState;
    this.position = saved.position;
    this.preStart = saved.preStart;
  }
}

/**
 * Create an extractor that reproduces {@link extractDocumentText} over a chunked
 * body while retaining only `characterLimit` characters of it.
 */
export function createStreamingExtractor(request: TextWindowRequest): StreamingExtractor {
  return new DocumentTextStream(request);
}

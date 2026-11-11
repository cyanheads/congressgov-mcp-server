/**
 * @fileoverview Incremental form of both document readings — consumes a body
 * chunk by chunk and retains only the requested character window.
 *
 * `extract-text.ts` is the normative definition of each reading: every
 * character offset in the `content` contract indexes into the string it
 * produces. This module reproduces that string exactly while holding constant
 * memory, so a document is bounded by how long it takes to stream rather than by
 * how much of it fits in a buffer. The two are pinned against each other by a
 * differential test — if this file drifts, that test fails, not production.
 *
 * The `html` reading ({@link extractHtmlText}) is one forward pass with no
 * rewinds: markup left open runs to the end of the body, so nothing it spans
 * is ever written and taken back. Its text goes through the same
 * {@link HtmlLayout} the whole-string reading uses, so the two differ only in
 * how they tokenize a body that arrives in chunks. The rest of this header
 * describes the `gpo` reading ({@link extractDocumentText}), which is not so
 * lucky.
 *
 * The whole-string pipeline is `normalize newlines → strip comments → choose
 * verbatim <pre> or sibling-normalized XML → strip tags → decode entities →
 * trim`, and three of those stages are decided by content that arrives
 * arbitrarily late:
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

import { decodeCharacterReference } from '@/utils/character-references.js';
import {
  HTML_TAG_ROLES,
  HtmlLayout,
  type HtmlTextSink,
  isHtmlWhitespace,
  isWhitespace,
  MAX_HTML_TAG_NAME,
} from './extract-text.js';
import type { DocumentReading } from './types.js';

/** The character window to retain while streaming, and the reading to apply. */
export interface TextWindowRequest {
  /** Maximum characters to keep, counted from `characterOffset`. */
  characterLimit: number;
  /** First character of the extracted text to keep, 0-based. */
  characterOffset: number;
  /** The reading the body gets — named by the caller, never sniffed from the body. */
  reading: DocumentReading;
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

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isTagNameCharacter(ch: string): boolean {
  return isAsciiLetter(ch) || isDigit(ch) || ch === '_' || ch === ':' || ch === '-' || ch === '.';
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

/** What a character-reference candidate resolves to, in the owning sink's own terms. */
interface ReferenceOutput {
  /** The text a well-formed reference decodes to. */
  decoded(text: string): void;
  /** A candidate that is not a reference, as the literal characters it was built from. */
  literal(text: string): void;
}

/** Everything a rewind has to put back of a {@link ReferenceDecoder}. */
interface ReferenceState {
  digits: string;
  hexMarker: string;
  kind: number;
  name: string;
  zeros: number;
}

/**
 * Incremental `&…;` recognizer shared by both readings. It buffers a candidate
 * a character at a time and hands the result to its owner: the decoded text
 * when the candidate closes as a known reference, the literal characters when
 * it turns out not to be one.
 */
class ReferenceDecoder {
  private digits = '';
  private hexMarker = '';
  private kind = ENTITY_NONE;
  private name = '';
  private zeros = 0;
  private readonly output: ReferenceOutput;

  constructor(output: ReferenceOutput) {
    this.output = output;
  }

  /** Whether a candidate is open, so the next character must go through {@link step}. */
  get pending(): boolean {
    return this.kind !== ENTITY_NONE;
  }

  /** Open a candidate at an `&`. */
  begin(): void {
    this.kind = ENTITY_AMP;
  }

  mark(): ReferenceState {
    return {
      digits: this.digits,
      hexMarker: this.hexMarker,
      kind: this.kind,
      name: this.name,
      zeros: this.zeros,
    };
  }

  restore(state: ReferenceState): void {
    this.digits = state.digits;
    this.hexMarker = state.hexMarker;
    this.kind = state.kind;
    this.name = state.name;
    this.zeros = state.zeros;
  }

  /** Advance the open candidate. Returns false when `ch` still needs handling. */
  step(ch: string): boolean {
    switch (this.kind) {
      case ENTITY_AMP:
        if (ch === '#') {
          this.kind = ENTITY_HASH;
          return true;
        }
        if (isAsciiLetter(ch)) {
          this.kind = ENTITY_NAMED;
          this.name = ch;
          return true;
        }
        break;
      case ENTITY_NAMED:
        if (isAsciiLetter(ch)) {
          this.name += ch;
          if (this.name.length > MAX_ENTITY_NAME) this.flush();
          return true;
        }
        if (ch === ';') {
          this.complete(this.name);
          return true;
        }
        break;
      case ENTITY_HASH:
        if (ch === 'x' || ch === 'X') {
          this.kind = ENTITY_HEX_MARKER;
          this.hexMarker = ch;
          return true;
        }
        if (isDigit(ch)) {
          this.kind = ENTITY_DEC;
          this.addDigit(ch, false);
          return true;
        }
        break;
      case ENTITY_HEX_MARKER:
        if (isHexDigit(ch)) {
          this.kind = ENTITY_HEX;
          this.addDigit(ch, true);
          return true;
        }
        break;
      case ENTITY_DEC:
        if (isDigit(ch)) {
          this.addDigit(ch, false);
          return true;
        }
        if (ch === ';') {
          this.complete(`#${this.digits || '0'}`);
          return true;
        }
        break;
      case ENTITY_HEX:
        if (isHexDigit(ch)) {
          this.addDigit(ch, true);
          return true;
        }
        if (ch === ';') {
          this.complete(`#${this.hexMarker}${this.digits || '0'}`);
          return true;
        }
        break;
    }
    this.flush();
    return false;
  }

  /** Write the open candidate as the literal characters it was built from. */
  flush(): void {
    const kind = this.kind;
    if (kind === ENTITY_NONE) return;
    let literal = '&';
    if (kind === ENTITY_NAMED) literal += this.name;
    else if (kind !== ENTITY_AMP) {
      literal += '#';
      if (kind === ENTITY_HEX_MARKER || kind === ENTITY_HEX) literal += this.hexMarker;
      literal += '0'.repeat(this.zeros) + this.digits;
    }
    this.reset();
    this.output.literal(literal);
  }

  /**
   * Leading zeros are counted rather than stored, so a reference padded to any
   * width still resolves without buffering it. Past the largest code point the
   * value can only climb, so the reference is already text.
   */
  private addDigit(ch: string, hex: boolean): void {
    if (this.digits === '' && ch === '0') {
      this.zeros++;
      return;
    }
    this.digits += ch;
    if (Number.parseInt(this.digits, hex ? 16 : 10) > MAX_CODE_POINT) this.flush();
  }

  private complete(ref: string): void {
    const decoded = decodeCharacterReference(ref);
    if (decoded === undefined) {
      this.flush();
      this.output.literal(';');
      return;
    }
    this.reset();
    this.output.decoded(decoded);
  }

  private reset(): void {
    this.digits = '';
    this.hexMarker = '';
    this.kind = ENTITY_NONE;
    this.name = '';
    this.zeros = 0;
  }
}

/** Minimal tag classification needed for XML sibling-boundary normalization. */
const TAG_UNDECIDED = 0;
const TAG_OPEN = 1;
const TAG_CLOSE_SLASH = 2;
const TAG_CLOSE = 3;
const TAG_SPECIAL = 4;
const TAG_OTHER = 5;

const INLINE_XML_TAGS = new Set(['a', 'b', 'em', 'i', 'span', 'strong', 'sub', 'sup']);
const MAX_INLINE_TAG_NAME = 6;

/** A rewind point for one sink. Fixed size, whatever the document does. */
interface SinkMark {
  emitted: number;
  inTag: boolean;
  lastEmittedWhitespace: boolean;
  pendingCloseRun: boolean;
  pendingCloseRunStructural: boolean;
  pendingSiblingSeparator: boolean;
  reference: ReferenceState;
  started: boolean;
  tagKind: number;
  tagMark: SinkMark | null;
  tagName: string;
  tagNameOverflow: boolean;
  tagNameReading: boolean;
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
  private inTag = false;
  private lastEmittedWhitespace = false;
  private pendingCloseRun = false;
  private pendingCloseRunStructural = false;
  private pendingSiblingSeparator = false;
  private readonly reference = new ReferenceDecoder({
    decoded: (text) => this.emit(text),
    literal: (text) => this.emit(text),
  });
  private started = false;
  private tagKind = TAG_UNDECIDED;
  private tagMark: SinkMark | null = null;
  private tagName = '';
  private tagNameOverflow = false;
  private tagNameReading = false;
  private trailingWs = 0;
  private readonly windowChars: string[] = [];
  private readonly windowEnd: number;

  constructor(
    private readonly windowStart: number,
    windowLimit: number,
    private readonly normalizeSiblingBoundaries = false,
  ) {
    this.windowEnd = windowStart + windowLimit;
  }

  write(text: string): void {
    let i = 0;
    while (i < text.length) {
      if (this.started && !this.inTag && !this.reference.pending) {
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
      inTag: this.inTag,
      lastEmittedWhitespace: this.lastEmittedWhitespace,
      pendingCloseRun: this.pendingCloseRun,
      pendingCloseRunStructural: this.pendingCloseRunStructural,
      pendingSiblingSeparator: this.pendingSiblingSeparator,
      reference: this.reference.mark(),
      started: this.started,
      tagKind: this.tagKind,
      tagMark: this.tagMark,
      tagName: this.tagName,
      tagNameOverflow: this.tagNameOverflow,
      tagNameReading: this.tagNameReading,
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
    this.inTag = mark.inTag;
    this.lastEmittedWhitespace = mark.lastEmittedWhitespace;
    this.pendingCloseRun = mark.pendingCloseRun;
    this.pendingCloseRunStructural = mark.pendingCloseRunStructural;
    this.pendingSiblingSeparator = mark.pendingSiblingSeparator;
    this.reference.restore(mark.reference);
    this.started = mark.started;
    this.tagKind = mark.tagKind;
    this.tagMark = mark.tagMark;
    this.tagName = mark.tagName;
    this.tagNameOverflow = mark.tagNameOverflow;
    this.tagNameReading = mark.tagNameReading;
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
    this.reference.flush();
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
        const completedTagKind = this.tagKind;
        const completedTagName = this.tagName;
        const completedTagNameOverflow = this.tagNameOverflow;
        this.restore(this.tagMark as SinkMark);
        this.completeTag(completedTagKind, completedTagName, completedTagNameOverflow);
        return;
      }
      this.classifyTagCharacter(ch);
      this.literal(ch);
      return;
    }
    if (ch === '<') {
      this.tagMark = this.mark();
      this.inTag = true;
      this.tagKind = TAG_UNDECIDED;
      this.tagName = '';
      this.tagNameOverflow = false;
      this.tagNameReading = false;
      this.literal(ch);
      return;
    }
    if (this.normalizeSiblingBoundaries) {
      this.pendingCloseRun = false;
      this.pendingCloseRunStructural = false;
    }
    this.literal(ch);
  }

  /** Classify a tag while retaining only enough of its name to identify inline tags. */
  private classifyTagCharacter(ch: string): void {
    if (this.tagKind === TAG_UNDECIDED) {
      if (isWhitespace(ch)) return;
      if (ch === '/') this.tagKind = TAG_CLOSE_SLASH;
      else if (ch === '!' || ch === '?') this.tagKind = TAG_SPECIAL;
      else if (isAsciiLetter(ch)) {
        this.tagKind = TAG_OPEN;
        this.tagNameReading = true;
        this.appendTagName(ch);
      } else this.tagKind = TAG_OTHER;
      return;
    }
    if (this.tagKind === TAG_CLOSE_SLASH && !isWhitespace(ch)) {
      if (isAsciiLetter(ch)) {
        this.tagKind = TAG_CLOSE;
        this.tagNameReading = true;
        this.appendTagName(ch);
      } else this.tagKind = TAG_OTHER;
      return;
    }
    if ((this.tagKind === TAG_OPEN || this.tagKind === TAG_CLOSE) && this.tagNameReading) {
      if (isTagNameCharacter(ch)) this.appendTagName(ch);
      else this.tagNameReading = false;
    }
  }

  private appendTagName(ch: string): void {
    if (this.tagName.length < MAX_INLINE_TAG_NAME) this.tagName += ch.toLowerCase();
    else this.tagNameOverflow = true;
  }

  /** Apply the no-`<pre>` close-to-open element boundary policy. */
  private completeTag(kind: number, name: string, nameOverflow: boolean): void {
    if (!this.normalizeSiblingBoundaries) return;
    if (kind === TAG_CLOSE) {
      this.pendingCloseRun = true;
      this.pendingCloseRunStructural ||= nameOverflow || !INLINE_XML_TAGS.has(name);
      return;
    }
    if (kind === TAG_OPEN && this.pendingCloseRun) {
      const structural =
        this.pendingCloseRunStructural || nameOverflow || !INLINE_XML_TAGS.has(name);
      this.pendingCloseRun = false;
      this.pendingCloseRunStructural = false;
      if (structural) {
        this.reference.flush();
        this.pendingSiblingSeparator = true;
      }
      return;
    }
    if (kind !== TAG_OPEN) {
      this.pendingCloseRun = false;
      this.pendingCloseRunStructural = false;
    }
  }

  /** Feed one character to the entity decoder. */
  private literal(ch: string): void {
    if (this.reference.pending && this.reference.step(ch)) return;
    if (ch === '&') {
      this.reference.begin();
      return;
    }
    this.emitChar(ch);
  }

  private emit(text: string): void {
    for (let i = 0; i < text.length; i++) this.emitChar(text[i] as string);
  }

  private emitChar(ch: string): void {
    if (this.pendingSiblingSeparator) {
      this.pendingSiblingSeparator = false;
      if (this.started && !this.lastEmittedWhitespace && !isWhitespace(ch)) this.appendChar(' ');
    }
    this.appendChar(ch);
  }

  private appendChar(ch: string): void {
    if (!this.started) {
      if (isWhitespace(ch)) return;
      this.started = true;
    }
    const index = this.emitted;
    this.emitted = index + 1;
    this.lastEmittedWhitespace = isWhitespace(ch);
    if (this.lastEmittedWhitespace) this.trailingWs++;
    else this.trailingWs = 0;
    if (index >= this.windowStart && index < this.windowEnd) this.windowChars.push(ch);
  }

  /** Bulk path for a run with no markup, no entity, and no whitespace in it. */
  private emitRun(text: string, from: number, to: number): void {
    if (this.normalizeSiblingBoundaries) {
      this.pendingCloseRun = false;
      this.pendingCloseRunStructural = false;
    }
    if (this.pendingSiblingSeparator) {
      this.emitChar(text[from] as string);
      from++;
      if (from === to) return;
    }
    const start = this.emitted;
    this.emitted = start + (to - from);
    this.lastEmittedWhitespace = false;
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
    this.noPre = new WindowSink(this.windowStart, this.windowLimit, true);
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

/** Tokenizer states of the `html` reading, named for what was read last. */
const HTML_DATA = 0;
/** `<` */
const HTML_TAG_OPEN = 1;
/** `</` */
const HTML_END_TAG_OPEN = 2;
/** `<` or `</`, then a letter: reading the tag name. */
const HTML_TAG_NAME = 3;
/** Past the tag name; the tag runs to the first `>`. */
const HTML_TAG = 4;
/** A bogus comment — `<?`, `<!x`, `</3` — running to the first `>`. */
const HTML_BOGUS = 5;
/** `<!` */
const HTML_MARKUP = 6;
/** `<!-` */
const HTML_MARKUP_DASH = 7;
/** The HTML tokenizer's comment states. Only where a comment ends matters, not what it holds. */
const HTML_COMMENT_START = 8;
const HTML_COMMENT_START_DASH = 9;
const HTML_COMMENT = 10;
const HTML_COMMENT_END_DASH = 11;
const HTML_COMMENT_END = 12;
const HTML_COMMENT_END_BANG = 13;
/** Inside `script` or `style`, watching for `</` + its name + whitespace, `/`, or `>`. */
const HTML_RAW = 14;
const HTML_RAW_LT = 15;
const HTML_RAW_SLASH = 16;
const HTML_RAW_NAME = 17;

function asciiLower(ch: string): string {
  return ch >= 'A' && ch <= 'Z' ? String.fromCharCode(ch.charCodeAt(0) | 0x20) : ch;
}

/**
 * The requested window of the `html` reading and the reading's whole length.
 * The reading never rewinds, so every character appended is final and the
 * window is kept as plain string pieces.
 */
class HtmlWindow implements HtmlTextSink {
  private emitted = 0;
  private readonly windowEnd: number;
  private readonly windowParts: string[] = [];
  private readonly windowStart: number;

  constructor(request: TextWindowRequest) {
    this.windowStart = request.characterOffset;
    this.windowEnd = request.characterOffset + request.characterLimit;
  }

  /** Count `source[from, to)` as written, keeping whatever of it falls in the window. */
  append(source: string, from: number, to: number): void {
    const start = this.emitted;
    this.emitted = start + (to - from);
    if (start >= this.windowEnd || this.emitted <= this.windowStart) return;
    this.windowParts.push(
      source.slice(
        from + Math.max(0, this.windowStart - start),
        Math.min(to, from + (this.windowEnd - start)),
      ),
    );
  }

  result(): ExtractedWindow {
    return { text: this.windowParts.join(''), totalCharacters: this.emitted };
  }
}

/**
 * The `html` reading over a chunked body: a tokenizer state machine feeding a
 * reference decoder feeding the same {@link HtmlLayout} the whole-string
 * reading uses, each holding a few fields whatever the document does. Unlike
 * the `gpo` reading it never rewinds — markup left open runs to the end of the
 * body, and a reference never spans markup.
 */
class HtmlTextStream implements StreamingExtractor {
  private readonly layout: HtmlLayout;
  private rawMatched = 0;
  private rawName = '';
  /** A decoded reference is text like any other: whitespace it decodes to collapses. */
  private readonly reference = new ReferenceDecoder({
    decoded: (text) => {
      for (const ch of text) {
        if (isHtmlWhitespace(ch)) this.layout.whitespace();
        else this.writeText(ch);
      }
    },
    literal: (text) => this.writeText(text),
  });
  private state = HTML_DATA;
  private tagIsEnd = false;
  private tagName = '';
  private tagNameOverflow = false;
  private readonly window: HtmlWindow;

  constructor(request: TextWindowRequest) {
    this.window = new HtmlWindow(request);
    this.layout = new HtmlLayout(this.window);
  }

  push(chunk: string): void {
    let i = 0;
    while (i < chunk.length) i = this.step(chunk, i);
  }

  /** Text pending at the end is written; markup left open is dropped with all it spanned. */
  finish(): ExtractedWindow {
    if (this.state === HTML_DATA) this.reference.flush();
    else if (this.state === HTML_TAG_OPEN) this.writeText('<');
    else if (this.state === HTML_END_TAG_OPEN) this.writeText('</');
    return this.window.result();
  }

  /** Consume from `chunk[i]` in the current state; returns where to continue. */
  private step(chunk: string, i: number): number {
    const ch = chunk[i] as string;
    switch (this.state) {
      case HTML_DATA:
        return this.data(chunk, i);
      case HTML_TAG_OPEN:
        if (isAsciiLetter(ch)) this.startTagName(ch, false);
        else if (ch === '/') this.state = HTML_END_TAG_OPEN;
        else if (ch === '!') this.state = HTML_MARKUP;
        else if (ch === '?') this.state = HTML_BOGUS;
        else {
          /** No markup after all: the `<` is text, and `ch` is read again as text. */
          this.writeText('<');
          this.state = HTML_DATA;
          return i;
        }
        return i + 1;
      case HTML_END_TAG_OPEN:
        if (isAsciiLetter(ch)) this.startTagName(ch, true);
        else this.state = ch === '>' ? HTML_DATA : HTML_BOGUS;
        return i + 1;
      case HTML_TAG_NAME:
        if (ch === '>') this.completeTag();
        else if (ch === '/' || isHtmlWhitespace(ch)) this.state = HTML_TAG;
        else if (this.tagName.length < MAX_HTML_TAG_NAME) this.tagName += asciiLower(ch);
        else this.tagNameOverflow = true;
        return i + 1;
      case HTML_TAG: {
        const gt = chunk.indexOf('>', i);
        if (gt === -1) return chunk.length;
        this.completeTag();
        return gt + 1;
      }
      case HTML_BOGUS: {
        const gt = chunk.indexOf('>', i);
        if (gt === -1) return chunk.length;
        this.state = HTML_DATA;
        return gt + 1;
      }
      case HTML_MARKUP:
        this.state = ch === '-' ? HTML_MARKUP_DASH : ch === '>' ? HTML_DATA : HTML_BOGUS;
        return i + 1;
      case HTML_MARKUP_DASH:
        this.state = ch === '-' ? HTML_COMMENT_START : ch === '>' ? HTML_DATA : HTML_BOGUS;
        return i + 1;
      case HTML_COMMENT_START:
        this.state = ch === '-' ? HTML_COMMENT_START_DASH : ch === '>' ? HTML_DATA : HTML_COMMENT;
        return i + 1;
      case HTML_COMMENT_START_DASH:
        this.state = ch === '-' ? HTML_COMMENT_END : ch === '>' ? HTML_DATA : HTML_COMMENT;
        return i + 1;
      case HTML_COMMENT: {
        const dash = chunk.indexOf('-', i);
        if (dash === -1) return chunk.length;
        this.state = HTML_COMMENT_END_DASH;
        return dash + 1;
      }
      case HTML_COMMENT_END_DASH:
        this.state = ch === '-' ? HTML_COMMENT_END : HTML_COMMENT;
        return i + 1;
      case HTML_COMMENT_END:
        if (ch === '>') this.state = HTML_DATA;
        else if (ch === '!') this.state = HTML_COMMENT_END_BANG;
        else if (ch !== '-') this.state = HTML_COMMENT;
        return i + 1;
      case HTML_COMMENT_END_BANG:
        this.state = ch === '-' ? HTML_COMMENT_END_DASH : ch === '>' ? HTML_DATA : HTML_COMMENT;
        return i + 1;
      case HTML_RAW: {
        const lt = chunk.indexOf('<', i);
        if (lt === -1) return chunk.length;
        this.state = HTML_RAW_LT;
        return lt + 1;
      }
      case HTML_RAW_LT:
        this.state = ch === '/' ? HTML_RAW_SLASH : ch === '<' ? HTML_RAW_LT : HTML_RAW;
        return i + 1;
      case HTML_RAW_SLASH:
        this.rawMatched = 0;
        this.matchRawName(ch);
        return i + 1;
      default:
        this.matchRawName(ch);
        return i + 1;
    }
  }

  /** Text, whitespace, and references, with a bulk path for a plain run. */
  private data(chunk: string, i: number): number {
    const ch = chunk[i] as string;
    if (this.reference.pending && this.reference.step(ch)) return i + 1;
    if (ch === '<') {
      this.state = HTML_TAG_OPEN;
      return i + 1;
    }
    if (ch === '&') {
      this.reference.begin();
      return i + 1;
    }
    let end = i + 1;
    if (isHtmlWhitespace(ch)) {
      while (end < chunk.length && isHtmlWhitespace(chunk[end] as string)) end++;
      this.layout.whitespace();
      return end;
    }
    while (end < chunk.length) {
      const next = chunk[end] as string;
      if (next === '<' || next === '&' || isHtmlWhitespace(next)) break;
      end++;
    }
    this.layout.write(chunk, i, end);
    return end;
  }

  /** One more character of `</name` inside a raw-text element, or its terminator. */
  private matchRawName(ch: string): void {
    if (this.rawMatched < this.rawName.length) {
      if (asciiLower(ch) === this.rawName[this.rawMatched]) {
        this.rawMatched++;
        this.state = HTML_RAW_NAME;
      } else {
        this.state = ch === '<' ? HTML_RAW_LT : HTML_RAW;
      }
      return;
    }
    if (ch === '>') {
      this.state = HTML_DATA;
    } else if (ch === '/' || isHtmlWhitespace(ch)) {
      /** The end tag found; like any tag it runs to its first `>`. */
      this.tagName = this.rawName;
      this.tagIsEnd = true;
      this.tagNameOverflow = false;
      this.state = HTML_TAG;
    } else {
      this.state = ch === '<' ? HTML_RAW_LT : HTML_RAW;
    }
  }

  private startTagName(ch: string, isEnd: boolean): void {
    this.tagIsEnd = isEnd;
    this.tagName = asciiLower(ch);
    this.tagNameOverflow = false;
    this.state = HTML_TAG_NAME;
  }

  /** A tag's `>` arrived: apply its role, entering raw text after a script or style start tag. */
  private completeTag(): void {
    const role = this.tagNameOverflow ? undefined : HTML_TAG_ROLES.get(this.tagName);
    this.state = HTML_DATA;
    if (role === undefined) return;
    if (role === 'raw' && !this.tagIsEnd) {
      this.rawName = this.tagName;
      this.state = HTML_RAW;
      return;
    }
    this.layout.tag(role, this.tagIsEnd);
  }

  /** Write text with no ASCII whitespace in it. */
  private writeText(text: string): void {
    this.layout.write(text, 0, text.length);
  }
}

/**
 * Create an extractor that reproduces the requested reading — {@link
 * extractDocumentText} for `gpo`, {@link extractHtmlText} for `html` — over a
 * chunked body while retaining only `characterLimit` characters of it.
 */
export function createStreamingExtractor(request: TextWindowRequest): StreamingExtractor {
  const { reading } = request;
  switch (reading) {
    case 'gpo':
      return new DocumentTextStream(request);
    case 'html':
      return new HtmlTextStream(request);
    default: {
      const unknown: never = reading;
      throw new Error(`Unknown document reading: ${String(unknown)}`);
    }
  }
}

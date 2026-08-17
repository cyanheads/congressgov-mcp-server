/**
 * @fileoverview Rich formatting for MCP tool output.
 *
 * content[] is the only field most LLM clients forward to the model —
 * structuredContent (from output schemas) is for programmatic use and is
 * NOT reliably forwarded. These formatters render complete, structured
 * markdown so the LLM can reason about all returned data.
 *
 * **Completeness invariant.** A record reaching any renderer — detail view or
 * list row — is rendered whole: every upstream field appears, and no value is
 * cut mid-string. A hand-built header may curate presentation, but a detail
 * header ends in `renderDetailRest`, a list row ends in `withRowRest`, and a
 * curated single-line row ends in `withUnnamedFields` — so a field none of them
 * names still reaches the reader. A collection a curated line renders lossily
 * (its latest entry only, or only some of each entry's fields) is deliberately
 * left out of the row's named set, so the fall-through carries it whole. The
 * single deliberate exception is a
 * `{count, url}` sub-resource reference, rendered as "N available": the URL is
 * the upstream REST endpoint, and the tool's own operation is the callable path
 * to those rows. Caps belong to pagination, which has a continuation path
 * (`pagination.nextOffset`, surfaced in every list header) — a nested collection
 * inside one record has none, so slicing it would drop data no follow-up call
 * could recover.
 *
 * See: https://github.com/cyanheads/mcp-ts-core/issues/19
 *
 * @module mcp-server/tools/format-helpers
 */

type TextBlock = { type: 'text'; text: string };
type ItemRenderer = (item: Record<string, unknown>, index: number) => string;

// ── Primitives ──────────────────────────────────────────────────────

function tb(content: string): TextBlock[] {
  return [{ type: 'text', text: content }];
}

/**
 * Strip HTML to plain text while preserving paragraph and line breaks. Upstream
 * summary fields and other narrative bodies ship as HTML; we want the visible
 * structure (paragraph boundaries) to survive into the rendered Markdown.
 *
 * Inline contexts that need single-line output should pass `{ inline: true }`.
 */
function stripHtml(html: string, { inline = false } = {}): string {
  const text = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  if (inline) return text.replace(/\s+/g, ' ').trim();

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Wrap an emphasis span's content in Markdown markers with the span's own
 * boundary whitespace kept *outside* them.
 *
 * Congress.gov summaries routinely place a space inside the tag
 * (`<em>de minimis </em>treatment`, `an<em> de minimis</em> threshold`).
 * Substituting the marker in place produces `*de minimis *treatment` — markers
 * that no Markdown parser binds as emphasis, and altered visible spacing either
 * way. A span with no non-whitespace content gets no markers at all.
 */
function wrapEmphasis(inner: string, marker: string): string {
  const core = inner.trim();
  if (!core) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const trail = inner.slice(inner.trimEnd().length);
  return `${lead}${marker}${core}${marker}${trail}`;
}

/**
 * Convert upstream HTML (Congress.gov bill summaries are returned with `<p>`,
 * `<strong>`, `<em>`, anchor tags) into readable Markdown that preserves
 * paragraph and emphasis structure.
 *
 * Emphasis is matched as a whole span rather than tag-by-tag so boundary
 * whitespace can be normalized (see `wrapEmphasis`) and an unclosed tag falls
 * through to the generic strip instead of leaving a stray marker.
 */
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, (_m, inner: string) =>
      wrapEmphasis(inner, '**'),
    )
    .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, (_m, inner: string) =>
      wrapEmphasis(inner, '*'),
    )
    .replace(/<\s*a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, '[$2]($1)')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Safe deep access for compact field display — collapses whitespace to a single line. */
function s(obj: unknown, ...path: string[]): string | undefined {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === 'string') return stripHtml(cur, { inline: true });
  if (typeof cur === 'number') return String(cur);
  return;
}

/** "**Label:** value" if value is truthy, otherwise undefined. */
function f(label: string, val: string | number | undefined | null): string | undefined {
  return val != null && val !== '' ? `**${label}:** ${val}` : undefined;
}

/** Join truthy values with separator. */
function join(values: (string | undefined | null | false)[], sep = ' | '): string {
  return values.filter(Boolean).join(sep);
}

// ── Rendering Core ──────────────────────────────────────────────────

function pagHeader(result: Record<string, unknown>): string {
  const p = result.pagination as Record<string, unknown> | undefined;
  const items = result.data as unknown[] | undefined;
  const count = (p?.count as number) ?? items?.length ?? 0;
  const next = p?.nextOffset as number | null | undefined;
  return `**${count} result${count !== 1 ? 's' : ''}**${next != null ? ` | next offset: ${next}` : ''}`;
}

/** Render a paginated list with header and per-item rendering. */
function renderList(result: Record<string, unknown>, renderItem?: ItemRenderer): string {
  const items = (result.data ?? []) as unknown[];
  const header = pagHeader(result);

  if (items.length === 0) {
    /** Distinguish "0 total" from "page is past the end" — the header alone reads
     * as "N items returned but didn't render" when count > 0 and the page is empty. */
    const p = result.pagination as Record<string, unknown> | undefined;
    const total = (p?.count as number) ?? 0;
    const pageHint =
      total > 0
        ? `_Page is empty — offset is past the end of ${total} total item${total !== 1 ? 's' : ''}._`
        : '_No matching results._';
    return [header, '', pageHint].filter(Boolean).join('\n\n');
  }

  const renderer = renderItem ?? renderGenericItem;
  const rendered = items.map((item, i) =>
    typeof item === 'object' && item !== null
      ? renderer(item as Record<string, unknown>, i)
      : `${i + 1}. ${String(item)}`,
  );
  return [header, '', ...rendered].filter(Boolean).join('\n\n');
}

/**
 * Render an object's remaining fields after a hand-built header. Skips keys
 * already consumed by the header so they don't repeat in the body.
 */
function renderDetailRest(obj: Record<string, unknown>, skip: Set<string>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!skip.has(k)) filtered[k] = v;
  return renderDetail(filtered);
}

/** Render any object as structured markdown. Used for detail views. */
function renderDetail(obj: unknown): string {
  if (obj == null) return 'No data.';
  if (typeof obj !== 'object') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 'No items.';
    return obj
      .map((item, i) =>
        typeof item === 'object' && item
          ? renderGenericItem(item as Record<string, unknown>, i)
          : `${i + 1}. ${String(item)}`,
      )
      .join('\n\n');
  }

  const record = obj as Record<string, unknown>;
  const lines: string[] = [];

  for (const [key, val] of Object.entries(record)) {
    if (val == null || val === '') continue;

    if (typeof val === 'string') {
      const inline = stripHtml(val, { inline: true });
      if (inline.length > 300) {
        lines.push(`**${key}:**`);
        lines.push(stripHtml(val));
      } else {
        lines.push(`**${key}:** ${inline}`);
      }
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`**${key}:** ${val}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) continue;
      lines.push(`\n**${key}** (${val.length}):`);
      for (const item of val) {
        if (typeof item === 'object' && item) {
          lines.push(`- ${renderInline(item as Record<string, unknown>)}`);
        } else {
          lines.push(`- ${String(item)}`);
        }
      }
    } else if (typeof val === 'object') {
      const nested = val as Record<string, unknown>;
      const nKeys = Object.keys(nested);

      // Sub-resource reference: { count, url } → "N available"
      if (nKeys.length <= 2 && 'count' in nested) {
        const count = nested.count as number;
        if (count > 0) lines.push(`**${key}:** ${count} available`);
        continue;
      }

      if (key === 'latestAction') {
        const line = latestActionLine(record);
        if (line) lines.push(line);
        continue;
      }

      // Small objects inline, larger ones nested
      if (nKeys.length <= 3) {
        lines.push(`**${key}:** ${renderInline(nested)}`);
      } else {
        lines.push(`\n**${key}:**`);
        for (const [k2, v2] of Object.entries(nested)) {
          if (v2 == null || v2 === '') continue;
          if (typeof v2 === 'string') lines.push(`  **${k2}:** ${stripHtml(v2, { inline: true })}`);
          else if (typeof v2 === 'number' || typeof v2 === 'boolean')
            lines.push(`  **${k2}:** ${v2}`);
          else if (typeof v2 === 'object' && v2)
            lines.push(`  **${k2}:** ${renderInline(v2 as Record<string, unknown>)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** Render any list item with all its fields. */
function renderGenericItem(item: Record<string, unknown>, index: number): string {
  /**
   * Only the keys the heading actually consumed are skipped below. A fixed
   * skip-list swallows the alternates: a committee-report row carries both a
   * `citation` and a `type`/`number` pair, and the heading built from the pair
   * would drop `H. Rept. 113-118` — the label Congress.gov itself publishes.
   */
  const named = new Set<string>();
  let id: string | undefined;
  if (item.type && item.number != null) {
    named.add('type').add('number');
    id = `${String(item.type).toUpperCase()} ${item.number}`;
  } else {
    id = pick(item, named, 'citation', 'bioguideId', 'systemCode');
  }

  const name = pick(
    item,
    named,
    'title',
    'name',
    'fullName',
    'directOrderName',
    'description',
    'question',
  );

  const heading = [id, name].filter(Boolean).join(': ') || 'Item';
  const lines = [`### ${index + 1}. ${heading}`];

  for (const [key, val] of Object.entries(item)) {
    if (val == null || val === '') continue;
    if (named.has(key)) continue;

    if (typeof val === 'string') {
      const inline = stripHtml(val, { inline: true });
      if (inline.length > 300) {
        lines.push(`**${key}:**`);
        lines.push(stripHtml(val));
      } else {
        lines.push(`**${key}:** ${inline}`);
      }
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`**${key}:** ${val}`);
    } else if (typeof val === 'object' && !Array.isArray(val) && val !== null) {
      const action = key === 'latestAction' ? latestActionLine(item) : undefined;
      if (action) {
        lines.push(action);
      } else {
        lines.push(`**${key}:** ${renderInline(val as Record<string, unknown>)}`);
      }
    } else if (Array.isArray(val) && val.length > 0) {
      if (typeof val[0] === 'string' || typeof val[0] === 'number') {
        lines.push(`**${key}:** ${val.join(', ')}`);
      } else {
        lines.push(`**${key}:** ${val.length} items`);
        for (const sub of val) {
          if (typeof sub === 'object' && sub !== null)
            lines.push(`  - ${renderInline(sub as Record<string, unknown>)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** Fields of a `latestAction` object the curated line names — `actionTime` is not one. */
const LATEST_ACTION_KEYS = new Set(['actionDate', 'text']);

/**
 * The `**Latest Action:** date — text` line, followed by any sub-field that
 * curation does not name. Every renderer that shows a `latestAction` object
 * shows it the same lossy way, so the fall-through lives here rather than in
 * each caller's key set — upstream carries `actionTime` on bill rows reached
 * through `member_lookup sponsored`, and it reached no `content[]` client.
 * Returns undefined when the row carries no latest action at all.
 */
function latestActionLine(item: Record<string, unknown>): string | undefined {
  const action = item.latestAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return;
  const record = action as Record<string, unknown>;
  const curated = [s(record, 'actionDate'), s(record, 'text')].filter(Boolean).join(' — ');
  const line = withUnnamedFields(record, curated, LATEST_ACTION_KEYS);
  return line ? `**Latest Action:** ${line.replace(/^ — /, '')}` : undefined;
}

/**
 * Compact one-line render of a small object. Compact but never lossy: values are
 * carried in full and nested objects/arrays recurse, so no field or character is
 * dropped at any depth.
 */
function renderInline(obj: Record<string, unknown>): string {
  return inlineFields(obj) || JSON.stringify(obj);
}

/** `key: value` pairs for one object level, recursing into nested values. */
function inlineFields(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val == null || val === '') continue;
    if (typeof val === 'string') {
      parts.push(`${key}: ${stripHtml(val, { inline: true })}`);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${key}: ${val}`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) continue;
      const items = val.map((item) =>
        typeof item === 'object' && item
          ? `{${inlineFields(item as Record<string, unknown>)}}`
          : String(item),
      );
      parts.push(`${key}: [${items.join('; ')}]`);
    } else if (typeof val === 'object') {
      const nested = inlineFields(val as Record<string, unknown>);
      if (nested) parts.push(`${key}: {${nested}}`);
    }
  }
  return parts.join(', ');
}

/**
 * A curated one-line render of a collection row, with any of the row's own
 * fields the curation never named appended.
 *
 * The `renderDetailRest` fall-through only reaches a record's top level: a
 * collection the header renders itself is skipped there, so a field its curated
 * line omits would otherwise leave `content[]` while staying in
 * `structuredContent` — the same loss for a term's `district` or a nominee's
 * `url` that a dropped top-level field used to be.
 */
function withUnnamedFields(
  row: Record<string, unknown>,
  curated: string,
  named: Set<string>,
): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!named.has(k)) rest[k] = v;
  const unnamed = inlineFields(rest);
  return unnamed ? `${curated} — ${unnamed}` : curated;
}

/**
 * A curated multi-line list row followed by every field of the row the curation
 * never named — the list-row counterpart to a detail header's `renderDetailRest`
 * tail. Without it a hand-built row renders a fixed field set, and anything
 * upstream adds (or the curation never reached, like a subcommittee's `parent`)
 * stays in `structuredContent` and never reaches a `content[]`-only client.
 */
function withRowRest(item: Record<string, unknown>, lines: string[], named: Set<string>): string {
  const rest = renderDetailRest(item, named);
  return rest ? [...lines, '', rest].join('\n') : lines.join('\n');
}

/**
 * First present value among `keys`, marking only the key actually consumed as
 * named. An alias chain (`updateDate ?? publishDate`) otherwise swallows the
 * alternates: they are distinct upstream facts, so the ones the header did not
 * render have to stay available to the fall-through. Renderers that call this
 * hold their key constant as an array and copy it into a fresh set per row —
 * `pick` mutates the set it is given.
 */
function pick(
  item: Record<string, unknown>,
  named: Set<string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const val = s(item, key);
    if (val != null && val !== '') {
      named.add(key);
      return val;
    }
  }
  return;
}

// ── Domain-Specific Item Renderers ──────────────────────────────────

/**
 * Public/private law citations from a bill or law record's `laws[]`, e.g.
 * "Public Law 118-90". Upstream `/law` rows mirror `/bill`, so the citation is
 * the only field distinguishing an enacted law from the bill it came from — it
 * has to reach both the list rows and the detail view.
 */
function lawCitations(item: Record<string, unknown>): string | undefined {
  const laws = item.laws;
  if (!Array.isArray(laws) || laws.length === 0) return;
  const cites = (laws as Record<string, unknown>[])
    .map((law) => join([s(law, 'type'), s(law, 'number')], ' '))
    .filter(Boolean);
  return cites.length > 0 ? cites.join(', ') : undefined;
}

function renderBillItem(item: Record<string, unknown>, i: number): string {
  const type = s(item, 'type')?.toUpperCase() ?? '';
  const number = s(item, 'number') ?? '';
  const title = s(item, 'title') ?? 'Untitled';
  const url = s(item, 'url');
  const id = type && number ? `${type} ${number}: ` : '';

  const lines = [`### ${i + 1}. ${id}${title}`];

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Chamber', s(item, 'originChamber')),
    f('Policy Area', s(item, 'policyArea', 'name')),
  ]);
  if (meta) lines.push(meta);

  const citation = lawCitations(item);
  if (citation) lines.push(`**Law:** ${citation}`);

  if (Array.isArray(item.sponsors) && item.sponsors.length > 0) {
    const sponsors = (item.sponsors as Record<string, unknown>[]).map((sp) => {
      const name = s(sp, 'fullName') ?? s(sp, 'firstName') ?? '?';
      const party = s(sp, 'party') ?? '';
      const state = s(sp, 'state') ?? '';
      return party || state ? `${name} (${[party, state].filter(Boolean).join('-')})` : name;
    });
    lines.push(`**Sponsor:** ${sponsors.join(', ')}`);
  }

  const latestAction = latestActionLine(item);
  if (latestAction) lines.push(latestAction);

  const updated = s(item, 'updateDate');
  if (updated) lines.push(`**Updated:** ${updated}`);
  if (url) lines.push(`**URL:** ${url}`);

  return withRowRest(item, lines, BILL_ROW_KEYS);
}

/** `sponsors` is absent: the curated line drops each sponsor's `bioguideId`. */
const BILL_ROW_KEYS = new Set([
  'type',
  'number',
  'title',
  'congress',
  'originChamber',
  'originChamberCode',
  'policyArea',
  'laws',
  'latestAction',
  'updateDate',
  'url',
]);

function renderMemberItem(item: Record<string, unknown>, i: number): string {
  const name =
    s(item, 'name') ?? s(item, 'directOrderName') ?? s(item, 'fullName') ?? 'Unknown Member';
  const url = s(item, 'url');
  const lines = [`### ${i + 1}. ${name}`];

  const meta = join([
    f('ID', s(item, 'bioguideId')),
    f('Party', s(item, 'partyName') ?? s(item, 'party')),
    f('State', s(item, 'state')),
    item.district != null ? f('District', s(item, 'district')) : undefined,
  ]);
  if (meta) lines.push(meta);

  // terms may be a direct array or nested as { item: [...] }
  const rawTerms = item.terms;
  const termsArr: Record<string, unknown>[] | undefined = Array.isArray(rawTerms)
    ? rawTerms
    : rawTerms &&
        typeof rawTerms === 'object' &&
        Array.isArray((rawTerms as Record<string, unknown>).item)
      ? ((rawTerms as Record<string, unknown>).item as Record<string, unknown>[])
      : undefined;

  if (termsArr && termsArr.length > 0) {
    const latest = termsArr.at(-1);
    const chamber = s(latest, 'chamber');
    const start = s(latest, 'startYear');
    const end = s(latest, 'endYear');
    const termRange = start && end ? `${start}–${end}` : start;
    lines.push(
      `**Latest Term:** ${[chamber, termRange].filter(Boolean).join(', ')}` +
        (termsArr.length > 1 ? ` (${termsArr.length} total)` : ''),
    );
  }

  if (url) lines.push(`**URL:** ${url}`);

  return withRowRest(item, lines, MEMBER_ROW_KEYS);
}

/** `terms` is absent: the curated line renders the latest term only. */
const MEMBER_ROW_KEYS = new Set([
  'bioguideId',
  'name',
  'directOrderName',
  'fullName',
  'partyName',
  'party',
  'state',
  'district',
  'url',
]);

function renderSummaryItem(item: Record<string, unknown>, i: number): string {
  const named = new Set(SUMMARY_ROW_KEYS);
  const billType = s(item, 'bill', 'type')?.toUpperCase() ?? '';
  const billNum = s(item, 'bill', 'number') ?? '';
  const congress = s(item, 'bill', 'congress') ?? '';
  const version = pick(item, named, 'actionDesc', 'versionCode') ?? '';
  const actionDate = s(item, 'actionDate') ?? '';
  const summaryUpdate = pick(item, named, 'lastSummaryUpdateDate', 'updateDate') ?? '';
  const rawText = typeof item.text === 'string' ? item.text : '';
  const text = rawText ? htmlToMarkdown(rawText) : '';
  const url = s(item, 'url') ?? s(item, 'bill', 'url');

  const ref = billType && billNum ? `${billType} ${billNum}` : 'Bill reference not available';
  const heading = congress ? `${ref}, Congress ${congress}` : ref;
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([
    f('Version', version),
    f('Action Date', actionDate),
    f('Summary Updated', summaryUpdate),
  ]);
  if (meta) lines.push(meta);

  const billTitle = s(item, 'bill', 'title');
  const billLine = `**Bill Title:** ${billTitle ?? 'Not available'}`;
  const bill = item.bill;
  lines.push(
    bill && typeof bill === 'object' && !Array.isArray(bill)
      ? withUnnamedFields(bill as Record<string, unknown>, billLine, BILL_REF_KEYS)
      : billLine,
  );

  // The summary text is the critical data — the whole point of this tool
  lines.push('');
  lines.push(text || '_Summary text not available._');
  if (url) lines.push(`\n**URL:** ${url}`);

  return withRowRest(item, lines, named);
}

/** `actionDesc`/`versionCode` and the two update dates are resolved by `pick`. */
const SUMMARY_ROW_KEYS = ['actionDate', 'text', 'url', 'bill'];

/** Fields of a summary row's nested bill reference the heading already renders. */
const BILL_REF_KEYS = new Set(['congress', 'type', 'number', 'title', 'url']);

function renderCrsReportItem(item: Record<string, unknown>, i: number): string {
  const named = new Set(CRS_REPORT_ROW_KEYS);
  const reportNumber =
    s(item, 'reportNumber') ?? s(item, 'number') ?? s(item, 'id') ?? 'Report number not available';
  const title = s(item, 'title') ?? 'Title not available';
  const updated = pick(item, named, 'updateDate', 'publishDate', 'date') ?? '';
  const summary = pick(item, named, 'summary', 'abstract') ?? '';
  const contentType = s(item, 'contentType');
  const status = s(item, 'status');
  const version = s(item, 'version');
  const url = s(item, 'url');

  const lines = [`### ${i + 1}. ${reportNumber}: ${title}`];
  const meta = join([
    f('Updated', updated),
    f('Type', contentType),
    f('Status', status),
    f('Version', version),
  ]);
  if (meta) lines.push(meta);
  if (summary) lines.push(summary);
  if (url) lines.push(`**URL:** ${url}`);

  return withRowRest(item, lines, named);
}

/**
 * The three identifier aliases are all named: upstream sends one of them, and
 * the heading renders whichever arrived. The date and summary aliases are
 * distinct facts, so `pick` names only the one the header consumed.
 */
const CRS_REPORT_ROW_KEYS = [
  'reportNumber',
  'number',
  'id',
  'title',
  'contentType',
  'status',
  'version',
  'url',
];

/** Daily Congressional Record articles — flattened from section-wrapped shape. */
function renderDailyArticleItem(item: Record<string, unknown>, i: number): string {
  const title = s(item, 'title') ?? 'Untitled article';
  const section = s(item, 'sectionName');
  const startPage = s(item, 'startPage');
  const endPage = s(item, 'endPage');
  const pages =
    startPage && endPage && startPage !== endPage ? `${startPage}–${endPage}` : startPage;

  const lines = [`### ${i + 1}. ${title}`];
  const meta = join([f('Section', section), f('Pages', pages)]);
  if (meta) lines.push(meta);

  const text = item.text;
  if (Array.isArray(text)) {
    for (const entry of text as Record<string, unknown>[]) {
      const type = s(entry, 'type');
      const url = s(entry, 'url');
      if (type && url) lines.push(`**${type}:** ${url}`);
    }
  }

  return withRowRest(item, lines, DAILY_ARTICLE_ROW_KEYS);
}

const DAILY_ARTICLE_ROW_KEYS = new Set(['title', 'sectionName', 'startPage', 'endPage', 'text']);

/** Daily Congressional Record volumes and issues. */
function renderDailyRecordItem(item: Record<string, unknown>, i: number): string {
  const volume = s(item, 'volumeNumber');
  const issue = s(item, 'issueNumber');
  const issueDate = s(item, 'issueDate')?.slice(0, 10);
  const congress = s(item, 'congress');
  const session = s(item, 'sessionNumber');
  const updated = s(item, 'updateDate');
  const url = s(item, 'url');

  const parts: string[] = [];
  if (volume) parts.push(`Volume ${volume}`);
  if (issue) parts.push(`Issue ${issue}`);
  const idPart = parts.join(', ');
  const heading = idPart && issueDate ? `${idPart} — ${issueDate}` : idPart || issueDate || 'Item';
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([f('Congress', congress), f('Session', session), f('Updated', updated)]);
  if (meta) lines.push(meta);
  if (url) lines.push(`**URL:** ${url}`);

  return withRowRest(item, lines, DAILY_RECORD_ROW_KEYS);
}

/** `issueDate` is absent: the heading shows the date, the fall-through the time. */
const DAILY_RECORD_ROW_KEYS = new Set([
  'volumeNumber',
  'issueNumber',
  'congress',
  'sessionNumber',
  'updateDate',
  'url',
]);

/** House roll call votes. */
function renderRollVoteItem(item: Record<string, unknown>, i: number): string {
  const roll = s(item, 'rollCallNumber');
  const identifier = s(item, 'identifier');
  const legType = s(item, 'legislationType')?.toUpperCase();
  const legNum = s(item, 'legislationNumber');
  const legislationUrl = s(item, 'legislationUrl');
  const result = s(item, 'result');
  const voteType = s(item, 'voteType');
  const startDate = s(item, 'startDate');
  const congress = s(item, 'congress');
  const session = s(item, 'sessionNumber');
  const updated = s(item, 'updateDate');
  const sourceUrl = s(item, 'sourceDataURL');
  const url = s(item, 'url');

  const legRef = legType && legNum ? `${legType} ${legNum}` : undefined;
  const rollLabel = roll ? `Roll ${roll}` : 'Roll call';
  const headingLeft = legRef ? `${rollLabel}: ${legRef}` : rollLabel;
  const heading = result ? `${headingLeft} — ${result}` : headingLeft;
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([
    f('Congress', congress),
    f('Session', session),
    f('Type', voteType),
    f('Date', startDate),
    identifier && identifier !== roll ? f('ID', identifier) : undefined,
    f('Updated', updated),
  ]);
  if (meta) lines.push(meta);
  if (legislationUrl) lines.push(`**Legislation URL:** ${legislationUrl}`);
  if (url) lines.push(`**URL:** ${url}`);
  if (sourceUrl) lines.push(`**Source Data URL:** ${sourceUrl}`);

  return withRowRest(item, lines, ROLL_VOTE_ROW_KEYS);
}

const ROLL_VOTE_ROW_KEYS = new Set([
  'rollCallNumber',
  'identifier',
  'legislationType',
  'legislationNumber',
  'legislationUrl',
  'result',
  'voteType',
  'startDate',
  'congress',
  'sessionNumber',
  'updateDate',
  'sourceDataURL',
  'url',
]);

/** Bill legislative actions. */
function renderBillActionItem(item: Record<string, unknown>, i: number): string {
  const actionDate = s(item, 'actionDate');
  const text = s(item, 'text') ?? 'No text';
  const type = s(item, 'type');
  const actionCode = s(item, 'actionCode');
  const source = s(item, 'sourceSystem', 'name');

  const heading = actionDate ? `${actionDate} — ${text}` : text;
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([f('Type', type), f('Action Code', actionCode), f('Source', source)]);
  if (meta) lines.push(meta);

  const committees = item.committees;
  if (Array.isArray(committees)) {
    const names = committees.map((c) => s(c, 'name')).filter(Boolean);
    if (names.length > 0) lines.push(`**Committees:** ${names.join(', ')}`);
  }

  return withRowRest(item, lines, BILL_ACTION_ROW_KEYS);
}

/** `committees` is absent: the name list drops each committee's `systemCode`. */
const BILL_ACTION_ROW_KEYS = new Set(['actionDate', 'text', 'type', 'actionCode', 'sourceSystem']);

/** Committee report text — items wrap a `formats` array of {type, url, isErrata}. */
function renderCommitteeReportTextItem(item: Record<string, unknown>, i: number): string {
  const formats = item.formats;
  if (!Array.isArray(formats) || formats.length === 0) {
    return renderGenericItem(item, i);
  }

  const entries = (formats as Record<string, unknown>[])
    .map((fmt) => ({
      type: s(fmt, 'type') ?? 'Unknown format',
      url: s(fmt, 'url'),
      isErrata: s(fmt, 'isErrata') === 'Y',
    }))
    .filter((e) => !!e.url);

  if (entries.length === 0) return renderGenericItem(item, i);

  const heading = entries.map((e) => (e.isErrata ? `${e.type} (Errata)` : e.type)).join(' / ');
  const lines = [`### ${i + 1}. ${heading}`];
  for (const e of entries) {
    const label = e.isErrata ? `${e.type} (Errata)` : e.type;
    lines.push(`**${label}:** ${e.url}`);
  }
  return withRowRest(item, lines, COMMITTEE_REPORT_TEXT_ROW_KEYS);
}

const COMMITTEE_REPORT_TEXT_ROW_KEYS = new Set(['formats']);

/** Member-sponsored amendments — `type`/`title` are null upstream; identify by `amendmentNumber`. */
function renderAmendmentItem(item: Record<string, unknown>, i: number): string {
  const number = s(item, 'amendmentNumber');
  const url = s(item, 'url') ?? '';
  /** URL path carries the chamber prefix (samdt / hamdt) we need for a readable type label. */
  const amdMatch = url.match(/\/amendment\/(\d+)\/(samdt|hamdt|suamdt|huamdt)\//i);
  const typeCode = amdMatch?.[2]?.toLowerCase();
  const chamber =
    typeCode === 'samdt' || typeCode === 'suamdt'
      ? 'Senate Amendment'
      : typeCode === 'hamdt' || typeCode === 'huamdt'
        ? 'House Amendment'
        : 'Amendment';
  const heading = number ? `${chamber} ${number}` : 'Amendment';
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Introduced', s(item, 'introducedDate')),
  ]);
  if (meta) lines.push(meta);

  const latestAction = latestActionLine(item);
  if (latestAction) lines.push(latestAction);

  if (url) lines.push(`**URL:** ${url}`);
  return withRowRest(item, lines, AMENDMENT_ROW_KEYS);
}

const AMENDMENT_ROW_KEYS = new Set([
  'amendmentNumber',
  'congress',
  'introducedDate',
  'latestAction',
  'url',
]);

/** Bill text versions — heading from `type` (e.g. "Enrolled Bill"), formats[] as labeled URLs. */
function renderBillTextItem(item: Record<string, unknown>, i: number): string {
  const type = s(item, 'type') ?? 'Bill Text';
  const date = s(item, 'date');
  const lines = [`### ${i + 1}. ${type}`];
  if (date) lines.push(`**Date:** ${date}`);

  const formats = item.formats;
  if (Array.isArray(formats)) {
    for (const fmt of formats as Record<string, unknown>[]) {
      const fType = s(fmt, 'type');
      const fUrl = s(fmt, 'url');
      if (fType && fUrl) lines.push(`**${fType}:** ${fUrl}`);
    }
  }
  return withRowRest(item, lines, BILL_TEXT_ROW_KEYS);
}

const BILL_TEXT_ROW_KEYS = new Set(['type', 'date', 'formats']);

/** Nomination type wrapper: `{isCivilian: true}` / `{isMilitary: true}` → readable label. */
function nominationTypeLabel(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return;
  const t = raw as Record<string, unknown>;
  if (t.isCivilian === true) return 'Civilian';
  if (t.isMilitary === true) return 'Military';
  return;
}

function nominationHeading(item: Record<string, unknown>): string {
  const citation = s(item, 'citation');
  if (citation) return citation;
  const number = s(item, 'number');
  const partNumber = s(item, 'partNumber');
  if (number && partNumber && partNumber !== '00') return `PN${number}-${Number(partNumber)}`;
  if (number) return `PN${number}`;
  return 'Nomination';
}

function renderNominationListItem(item: Record<string, unknown>, i: number): string {
  const heading = nominationHeading(item);
  const type = nominationTypeLabel(item.nominationType);
  const lines = [`### ${i + 1}. ${heading}`];

  const description = s(item, 'description');
  if (description) lines.push(description);

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Type', type),
    f('Received', s(item, 'receivedDate')),
    f('Authority Date', s(item, 'authorityDate')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);

  const latestAction = latestActionLine(item);
  if (latestAction) lines.push(latestAction);

  const url = s(item, 'url');
  if (url) lines.push(`**URL:** ${url}`);
  return withRowRest(item, lines, NOMINATION_ROW_KEYS);
}

const NOMINATION_ROW_KEYS = new Set([
  'citation',
  'number',
  'partNumber',
  'nominationType',
  'description',
  'congress',
  'receivedDate',
  'authorityDate',
  'updateDate',
  'latestAction',
  'url',
]);

/** Nomination committee items — shape {name, systemCode, chamber, type, activities[], url}. */
function renderNominationCommitteeItem(item: Record<string, unknown>, i: number): string {
  const name = s(item, 'name') ?? s(item, 'systemCode') ?? 'Committee';
  const lines = [`### ${i + 1}. ${name}`];
  const meta = join([
    f('Code', s(item, 'systemCode')),
    f('Chamber', s(item, 'chamber')),
    f('Type', s(item, 'type')),
  ]);
  if (meta) lines.push(meta);

  const activities = item.activities;
  if (Array.isArray(activities) && activities.length > 0) {
    lines.push('**Activities:**');
    for (const a of activities as Record<string, unknown>[]) {
      const date = s(a, 'date')?.slice(0, 10);
      const aname = s(a, 'name');
      lines.push(`- ${[date, aname].filter(Boolean).join(' — ')}`);
    }
  }

  const url = s(item, 'url');
  if (url) lines.push(`**URL:** ${url}`);
  return withRowRest(item, lines, NOMINATION_COMMITTEE_ROW_KEYS);
}

/** `activities` is absent: the curated lines cut each activity date to 10 chars. */
const NOMINATION_COMMITTEE_ROW_KEYS = new Set(['name', 'systemCode', 'chamber', 'type', 'url']);

/** Individual nominee items — shape {firstName, middleName, lastName, ordinal, state, prefix?, suffix?}. */
function renderNomineeItem(item: Record<string, unknown>, i: number): string {
  const prefix = s(item, 'prefix');
  const first = s(item, 'firstName');
  const middle = s(item, 'middleName');
  const last = s(item, 'lastName');
  const suffix = s(item, 'suffix');
  const name = [prefix, first, middle, last, suffix].filter(Boolean).join(' ').trim();

  const heading = name || 'Nominee';
  const lines = [`### ${i + 1}. ${heading}`];
  const meta = join([f('Ordinal', s(item, 'ordinal')), f('State', s(item, 'state'))]);
  if (meta) lines.push(meta);
  return withRowRest(item, lines, NOMINEE_ITEM_KEYS);
}

const NOMINEE_ITEM_KEYS = new Set([
  'prefix',
  'firstName',
  'middleName',
  'lastName',
  'suffix',
  'ordinal',
  'state',
]);

/** Nomination hearing items — shape {chamber, citation, date, jacketNumber, number, partNumber, errata?}. */
function renderNominationHearingItem(item: Record<string, unknown>, i: number): string {
  const citation = s(item, 'citation');
  const number = s(item, 'number');
  const heading = citation ?? (number ? `Hearing ${number}` : 'Hearing');
  const lines = [`### ${i + 1}. ${heading}`];

  const partNumber = s(item, 'partNumber');
  const meta = join([
    f('Chamber', s(item, 'chamber')),
    f('Date', s(item, 'date')),
    f('Number', number),
    partNumber && partNumber !== '1' && partNumber !== '01' ? f('Part', partNumber) : undefined,
    f('Jacket', s(item, 'jacketNumber')),
    s(item, 'errata') === 'Y' ? '_Errata_' : undefined,
  ]);
  if (meta) lines.push(meta);
  return withRowRest(item, lines, NOMINATION_HEARING_ROW_KEYS);
}

const NOMINATION_HEARING_ROW_KEYS = new Set([
  'citation',
  'number',
  'chamber',
  'date',
  'partNumber',
  'jacketNumber',
  'errata',
]);

/** Dispatch nomination list rows to the right renderer by shape signal. */
function pickNominationListRenderer(first: Record<string, unknown>): ItemRenderer {
  /** Action rows share the bill-action shape (actionDate, text, type, actionCode);
   * bill-specific extensions (committees, sourceSystem) are absent and no-op. */
  if ('actionDate' in first && 'text' in first) return renderBillActionItem;
  /** Nominee rows: firstName/lastName, or ordinal + state without citation. */
  if ('firstName' in first || 'lastName' in first) return renderNomineeItem;
  /** Committee rows: systemCode + name. */
  if ('systemCode' in first && 'name' in first) return renderNominationCommitteeItem;
  /** Hearing rows: jacketNumber is unique to hearings. */
  if ('jacketNumber' in first) return renderNominationHearingItem;
  /** Default: nomination list rows (citation/number/partNumber + description/nominationType). */
  return renderNominationListItem;
}

function renderNominationDetail(item: Record<string, unknown>): string {
  const heading = nominationHeading(item);
  const type = nominationTypeLabel(item.nominationType);
  const lines = [`# ${heading}`];

  const description = s(item, 'description');
  if (description) lines.push(description);

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Type', type),
    f('Part Number', s(item, 'partNumber')),
    f('Received', s(item, 'receivedDate')),
    f('Authority Date', s(item, 'authorityDate')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);

  const latestAction = latestActionLine(item);
  if (latestAction) lines.push(latestAction);

  const subResources: string[] = [];
  for (const key of ['actions', 'committees', 'hearings']) {
    const sub = item[key] as Record<string, unknown> | undefined;
    if (sub && typeof sub.count === 'number' && sub.count > 0)
      subResources.push(`${sub.count} ${key}`);
  }
  if (subResources.length) lines.push(`**Available:** ${subResources.join(', ')}`);

  const nominees = item.nominees;
  if (Array.isArray(nominees) && nominees.length > 0) {
    lines.push(`\n**Nominees (${nominees.length}):**`);
    for (const n of nominees as Record<string, unknown>[]) {
      const ord = s(n, 'ordinal');
      const count = s(n, 'nomineeCount');
      const org = s(n, 'organization');
      const title = s(n, 'positionTitle');
      const parts = [
        ord ? `Ord ${ord}` : undefined,
        count ? `${count} nominee(s)` : undefined,
        org,
        title,
      ].filter(Boolean);
      lines.push(`- ${withUnnamedFields(n, parts.join(' — '), NOMINEE_ROW_KEYS)}`);
    }
  } else if (s(item, 'partNumber') === '00') {
    /** Parent nominations (partNumber=00) have no nominees array. Sub-resources
     * also return 0 results — they live on the partitioned children (PN851-1, PN851-2, …). */
    lines.push(
      '\n_This is a parent nomination. Individual nominees and confirmation actions live on partitioned children (e.g. `PN851-1`, `PN851-2`). Use the partitioned form for `actions`, `committees`, `hearings`, or `nominees`._',
    );
  }

  const url = s(item, 'url');
  if (url) lines.push(`\n**URL:** ${url}`);

  const rest = renderDetailRest(item, HEADER_NOMINATION_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

const NOMINEE_ROW_KEYS = new Set(['ordinal', 'nomineeCount', 'organization', 'positionTitle']);

const HEADER_NOMINATION_KEYS = new Set([
  'citation',
  'number',
  'partNumber',
  'nominationType',
  'description',
  'congress',
  'receivedDate',
  'authorityDate',
  'updateDate',
  'latestAction',
  'actions',
  'committees',
  'hearings',
  'nominees',
  'url',
]);

/** Roll call vote detail — question, result, date, party totals. */
function renderRollVoteDetail(item: Record<string, unknown>): string {
  const roll = s(item, 'rollCallNumber');
  const congress = s(item, 'congress');
  const session = s(item, 'sessionNumber');
  const result = s(item, 'result');
  const question = s(item, 'voteQuestion');
  const voteType = s(item, 'voteType');
  const startDate = s(item, 'startDate');
  const updated = s(item, 'updateDate');
  const identifier = s(item, 'identifier');
  const sourceUrl = s(item, 'sourceDataURL');

  const headingLeft = roll ? `Roll ${roll}` : 'Roll call';
  const heading = result ? `${headingLeft} — ${result}` : headingLeft;
  const lines = [`# ${heading}`];

  if (question) lines.push(`**Question:** ${question}`);

  const meta = join([
    f('Congress', congress),
    f('Session', session),
    f('Type', voteType),
    f('Date', startDate),
    f('Updated', updated),
    identifier && identifier !== roll ? f('ID', identifier) : undefined,
  ]);
  if (meta) lines.push(meta);

  const totals = item.votePartyTotal;
  if (Array.isArray(totals) && totals.length > 0) {
    lines.push('\n**Party Totals:**');
    for (const t of totals as Record<string, unknown>[]) {
      const party = s(t, 'party', 'name') ?? s(t, 'voteParty') ?? '?';
      const yea = s(t, 'yeaTotal') ?? '0';
      const nay = s(t, 'nayTotal') ?? '0';
      const present = s(t, 'presentTotal') ?? '0';
      const notVoting = s(t, 'notVotingTotal') ?? '0';
      lines.push(
        `- **${party}:** Yea ${yea}, Nay ${nay}, Present ${present}, Not Voting ${notVoting}`,
      );
    }
  }

  if (sourceUrl) lines.push(`\n**Source Data URL:** ${sourceUrl}`);

  const rest = renderDetailRest(item, HEADER_ROLL_VOTE_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

const HEADER_ROLL_VOTE_KEYS = new Set([
  'rollCallNumber',
  'congress',
  'sessionNumber',
  'result',
  'voteQuestion',
  'voteType',
  'startDate',
  'updateDate',
  'identifier',
  'sourceDataURL',
  'votePartyTotal',
]);

/** One member's position: "Warren Davidson (R-OH) → Nay". */
function renderMemberVoteRow(r: Record<string, unknown>): string {
  const named = new Set(MEMBER_VOTE_ROW_KEYS);
  const first = s(r, 'firstName');
  const last = s(r, 'lastName');
  const name =
    (first && last ? `${first} ${last}` : (last ?? first)) ?? pick(r, named, 'bioguideId') ?? '?';
  const party = s(r, 'voteParty');
  const state = s(r, 'voteState');
  const cast = s(r, 'voteCast');
  const loc =
    party && state
      ? `(${party}-${state})`
      : party
        ? `(${party})`
        : state
          ? `(${state})`
          : undefined;
  const curated = `- ${[name, loc, cast ? `→ ${cast}` : undefined].filter(Boolean).join(' ')}`;
  return withUnnamedFields(r, curated, named);
}

/** `bioguideId` is named only when it stood in for a missing name. */
const MEMBER_VOTE_ROW_KEYS = ['firstName', 'lastName', 'voteParty', 'voteState', 'voteCast'];

/**
 * Member voting positions for one roll call — vote-context header, the
 * `pagination`-derived range footer, then the paginated roster from `data[]`.
 * The `vote` sibling carries the vote record (sans the roster); `get` adds party
 * totals this `/members` endpoint omits.
 */
function renderVoteMembers(result: Record<string, unknown>): string {
  const vote = (result.vote ?? {}) as Record<string, unknown>;
  const rows = (result.data ?? []) as unknown[];
  const pagination = result.pagination as Record<string, unknown> | undefined;
  const total = (pagination?.count as number) ?? rows.length;
  const nextOffset = pagination?.nextOffset as number | null | undefined;

  const roll = s(vote, 'rollCallNumber');
  const congress = s(vote, 'congress');
  const session = s(vote, 'sessionNumber');
  const rollLabel = roll ? `Roll ${roll}` : 'Roll call';
  const scope = join(
    [congress ? `${congress}th Congress` : undefined, session ? `session ${session}` : undefined],
    ', ',
  );
  const lines = [`# ${scope ? `${rollLabel} — ${scope}` : rollLabel}`];

  const context = join(
    [s(vote, 'voteQuestion') ? `**${s(vote, 'voteQuestion')}**` : undefined, s(vote, 'result')],
    ' — ',
  );
  if (context) lines.push(context);
  const legType = s(vote, 'legislationType')?.toUpperCase();
  const legNum = s(vote, 'legislationNumber');
  if (legType && legNum) lines.push(`**Legislation:** ${legType} ${legNum}`);

  const voteRest = renderDetailRest(vote, VOTE_CONTEXT_KEYS);
  if (voteRest) lines.push('', voteRest);

  if (rows.length === 0) {
    lines.push(
      '',
      total > 0
        ? `_Page is empty — offset is past the end of ${total} member position${total !== 1 ? 's' : ''}._`
        : '_No member positions recorded for this roll call._',
    );
    return lines.join('\n');
  }

  /** `pagination` omits the current offset; derive the page's 1-based range from
   * the row count and `nextOffset` (= offset + page length, or null on the last page). */
  const end = nextOffset ?? total;
  const start = end - rows.length + 1;
  lines.push(
    '',
    `**Members ${start}–${end} of ${total}**${nextOffset != null ? ` · next offset: ${nextOffset}` : ''}`,
    '',
  );
  for (const r of rows) {
    if (typeof r === 'object' && r !== null)
      lines.push(renderMemberVoteRow(r as Record<string, unknown>));
  }
  return lines.join('\n');
}

/** Fields of the `vote` context sibling the members header already renders. */
const VOTE_CONTEXT_KEYS = new Set([
  'rollCallNumber',
  'congress',
  'sessionNumber',
  'voteQuestion',
  'result',
  'legislationType',
  'legislationNumber',
]);

// ── Senate roll call votes (LIS feed) ───────────────────────────────

/**
 * Senate vote payloads come from the LIS XML feed, not the Congress.gov JSON API,
 * so they carry a distinct field set (and a `chamber: 'senate'` marker). These
 * renderers handle that shape; `formatVotes` routes to them via `isSenateResult`.
 */

/** Senate vote list row (from the session menu). */
function renderSenateVoteItem(item: Record<string, unknown>, i: number): string {
  const num = s(item, 'voteNumber');
  const issue = s(item, 'issue');
  const result = s(item, 'result');
  const question = s(item, 'question');
  const measure = s(item, 'measure');

  const left = num ? `Vote ${num}` : 'Senate vote';
  const headingLeft = issue ? `${left}: ${issue}` : left;
  const heading = result ? `${headingLeft} — ${result}` : headingLeft;
  const lines = [`### ${i + 1}. ${heading}`];

  if (question) lines.push(`**Question:** ${measure ? `${question} (${measure})` : question}`);

  const meta = join([
    f('Date', s(item, 'voteDate')),
    f('Yeas', s(item, 'yeas')),
    f('Nays', s(item, 'nays')),
  ]);
  if (meta) lines.push(meta);

  const title = s(item, 'title');
  if (title) lines.push(title);
  return withRowRest(item, lines, SENATE_VOTE_ROW_KEYS);
}

/** `chamber` is the dispatch marker, implicit in the Senate heading. */
const SENATE_VOTE_ROW_KEYS = new Set([
  'chamber',
  'voteNumber',
  'issue',
  'result',
  'question',
  'measure',
  'voteDate',
  'yeas',
  'nays',
  'title',
]);

/** One Senate member's position — uses the feed's pre-formatted "Baldwin (D-WI)" label. */
function renderSenateMemberRow(r: Record<string, unknown>): string {
  const cast = s(r, 'voteCast');
  const full = s(r, 'memberFull');
  if (full) {
    /** The feed composes memberFull from the last name, party, and state. */
    const named = new Set([...SENATE_MEMBER_ROW_KEYS, 'memberFull', 'lastName', 'party', 'state']);
    return withUnnamedFields(r, `- ${full}${cast ? ` → ${cast}` : ''}`, named);
  }

  const named = new Set([...SENATE_MEMBER_ROW_KEYS, 'firstName', 'lastName', 'party', 'state']);
  const first = s(r, 'firstName');
  const last = s(r, 'lastName');
  const name =
    (first && last ? `${first} ${last}` : (last ?? first)) ?? pick(r, named, 'lisMemberId') ?? '?';
  const party = s(r, 'party');
  const state = s(r, 'state');
  const loc =
    party && state
      ? `(${party}-${state})`
      : party
        ? `(${party})`
        : state
          ? `(${state})`
          : undefined;
  const curated = `- ${[name, loc, cast ? `→ ${cast}` : undefined].filter(Boolean).join(' ')}`;
  return withUnnamedFields(r, curated, named);
}

const SENATE_MEMBER_ROW_KEYS = ['chamber', 'voteCast'];

/** Senate vote detail — question, result, tally, derived party totals, document/amendment. */
function renderSenateVoteDetail(item: Record<string, unknown>): string {
  const num = s(item, 'voteNumber');
  const resultText = s(item, 'voteResultText') ?? s(item, 'voteResult');

  const headingLeft = num ? `Senate Vote ${num}` : 'Senate roll call';
  const heading = resultText ? `${headingLeft} — ${resultText}` : headingLeft;
  const lines = [`# ${heading}`];

  const questionText = s(item, 'voteQuestionText') ?? s(item, 'question');
  if (questionText) lines.push(`**Question:** ${questionText}`);
  const voteTitle = s(item, 'voteTitle');
  if (voteTitle) lines.push(`**Title:** ${voteTitle}`);

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Session', s(item, 'session')),
    f('Date', s(item, 'voteDate')),
    f('Majority Required', s(item, 'majorityRequirement')),
  ]);
  if (meta) lines.push(meta);

  const count = item.count as Record<string, unknown> | undefined;
  if (count) {
    lines.push(
      `\n**Tally:** ${join(
        [
          `Yea ${s(count, 'yeas') ?? 0}`,
          `Nay ${s(count, 'nays') ?? 0}`,
          `Present ${s(count, 'present') ?? 0}`,
          `Not Voting ${s(count, 'absent') ?? 0}`,
        ],
        ' · ',
      )}`,
    );
  }

  const totals = item.partyTotals;
  if (Array.isArray(totals) && totals.length > 0) {
    lines.push('\n**Party Totals** _(derived from the roster)_:');
    for (const t of totals as Record<string, unknown>[]) {
      const party = s(t, 'party') ?? '?';
      lines.push(
        `- **${party}:** Yea ${s(t, 'yea') ?? 0}, Nay ${s(t, 'nay') ?? 0}, Present ${s(t, 'present') ?? 0}, Not Voting ${s(t, 'notVoting') ?? 0}`,
      );
    }
  }

  const doc = item.document as Record<string, unknown> | undefined;
  const docTitle = doc ? (s(doc, 'title') ?? s(doc, 'shortTitle')) : undefined;
  if (doc) {
    const parts = [s(doc, 'type'), s(doc, 'name') ?? s(doc, 'number'), docTitle].filter(Boolean);
    if (parts.length) lines.push(`\n**Document:** ${parts.join(' — ')}`);
  }

  const amd = item.amendment as Record<string, unknown> | undefined;
  let amendmentPurpose: string | undefined;
  if (amd) {
    const amdNum = s(amd, 'number');
    const to = s(amd, 'toDocumentNumber');
    const toTitle = s(amd, 'toDocumentShortTitle');
    amendmentPurpose = s(amd, 'purpose');
    const head = [amdNum, to ? `to ${to}` : undefined, toTitle ? `— ${toTitle}` : undefined]
      .filter(Boolean)
      .join(' ');
    if (head) lines.push(`\n**Amendment:** ${head}`);
    if (amendmentPurpose) lines.push(`**Purpose:** ${amendmentPurpose}`);
  }

  /** Surface the matter narrative only when it adds something the document title and
   * amendment purpose haven't already shown. */
  const docText = s(item, 'voteDocumentText');
  if (docText && docText !== amendmentPurpose && docText !== docTitle) lines.push(`\n${docText}`);

  const rest = renderDetailRest(item, HEADER_SENATE_VOTE_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

/**
 * `chamber` is implicit in the "Senate Vote" heading; `voteResult` / `question`
 * are the short forms of `voteResultText` / `voteQuestionText`, one of which the
 * header always renders.
 */
const HEADER_SENATE_VOTE_KEYS = new Set([
  'chamber',
  'voteNumber',
  'voteResult',
  'voteResultText',
  'question',
  'voteQuestionText',
  'voteTitle',
  'congress',
  'session',
  'voteDate',
  'majorityRequirement',
  'count',
  'partyTotals',
  'document',
  'amendment',
  'voteDocumentText',
]);

/** Senate member voting positions for one roll call — mirrors the House members view. */
function renderSenateVoteMembers(result: Record<string, unknown>): string {
  const vote = (result.vote ?? {}) as Record<string, unknown>;
  const rows = (result.data ?? []) as unknown[];
  const pagination = result.pagination as Record<string, unknown> | undefined;
  const total = (pagination?.count as number) ?? rows.length;
  const nextOffset = pagination?.nextOffset as number | null | undefined;

  const num = s(vote, 'voteNumber');
  const congress = s(vote, 'congress');
  const session = s(vote, 'session');
  const label = num ? `Senate Vote ${num}` : 'Senate roll call';
  const scope = join(
    [congress ? `${congress}th Congress` : undefined, session ? `session ${session}` : undefined],
    ', ',
  );
  const lines = [`# ${scope ? `${label} — ${scope}` : label}`];

  const context = join(
    [
      s(vote, 'voteQuestionText')
        ? `**${s(vote, 'voteQuestionText')}**`
        : s(vote, 'question')
          ? `**${s(vote, 'question')}**`
          : undefined,
      s(vote, 'voteResultText') ?? s(vote, 'voteResult'),
    ],
    ' — ',
  );
  if (context) lines.push(context);

  const voteRest = renderDetailRest(vote, SENATE_VOTE_CONTEXT_KEYS);
  if (voteRest) lines.push('', voteRest);

  if (rows.length === 0) {
    lines.push(
      '',
      total > 0
        ? `_Page is empty — offset is past the end of ${total} member position${total !== 1 ? 's' : ''}._`
        : '_No member positions recorded for this roll call._',
    );
    return lines.join('\n');
  }

  const end = nextOffset ?? total;
  const start = end - rows.length + 1;
  lines.push(
    '',
    `**Members ${start}–${end} of ${total}**${nextOffset != null ? ` · next offset: ${nextOffset}` : ''}`,
    '',
  );
  for (const r of rows) {
    if (typeof r === 'object' && r !== null)
      lines.push(renderSenateMemberRow(r as Record<string, unknown>));
  }
  return lines.join('\n');
}

/** Fields of the Senate `vote` context sibling the members header already renders. */
const SENATE_VOTE_CONTEXT_KEYS = new Set([
  'chamber',
  'voteNumber',
  'congress',
  'session',
  'voteQuestionText',
  'question',
  'voteResultText',
  'voteResult',
]);

/** Senate payloads carry a `chamber: 'senate'` marker on the envelope, vote, and items. */
function isSenateResult(result: Record<string, unknown>): boolean {
  if (result.chamber === 'senate') return true;
  const vote = result.vote as Record<string, unknown> | undefined;
  if (vote?.chamber === 'senate') return true;
  const first = Array.isArray(result.data) ? result.data[0] : undefined;
  return !!(
    first &&
    typeof first === 'object' &&
    (first as Record<string, unknown>).chamber === 'senate'
  );
}

/** Bill / law detail — title-first header, then the rest of the structured fields. */
function renderBillDetail(item: Record<string, unknown>): string {
  const type = s(item, 'type')?.toUpperCase() ?? '';
  const number = s(item, 'number') ?? '';
  const title = s(item, 'title') ?? 'Untitled';
  const id = type && number ? `${type} ${number}: ` : '';
  const lines = [`# ${id}${title}`];

  const meta = join([
    f('Congress', s(item, 'congress')),
    f('Chamber', s(item, 'originChamber')),
    f('Policy Area', s(item, 'policyArea', 'name')),
    f('Introduced', s(item, 'introducedDate')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);

  const latestAction = latestActionLine(item);
  if (latestAction) lines.push(latestAction);

  const citation = lawCitations(item);
  if (citation) lines.push(`**Law:** ${citation}`);

  const rest = renderDetailRest(item, HEADER_BILL_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

const HEADER_BILL_KEYS = new Set([
  'type',
  'number',
  'title',
  'congress',
  'originChamber',
  'originChamberCode',
  'policyArea',
  'introducedDate',
  'updateDate',
  'latestAction',
  'laws',
]);

/** CRS report detail — title-first header, then the rest of the structured fields. */
function renderCrsReportDetail(item: Record<string, unknown>): string {
  const reportNumber = s(item, 'id') ?? s(item, 'reportNumber') ?? s(item, 'number');
  const title = s(item, 'title') ?? 'Title not available';
  const heading = reportNumber ? `${reportNumber}: ${title}` : title;
  const lines = [`# ${heading}`];

  const meta = join([
    f('Type', s(item, 'contentType')),
    f('Status', s(item, 'status')),
    f('Version', s(item, 'currentVersion') ?? s(item, 'version')),
    f('Published', s(item, 'publishDate')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);

  const authors = item.authors;
  if (Array.isArray(authors) && authors.length > 0) {
    const names = (authors as Record<string, unknown>[])
      .map((a) => s(a, 'author') ?? s(a, 'name'))
      .filter(Boolean);
    if (names.length) lines.push(`**Authors:** ${names.join(', ')}`);
  }

  const rest = renderDetailRest(item, HEADER_CRS_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

const HEADER_CRS_KEYS = new Set([
  'id',
  'reportNumber',
  'number',
  'title',
  'contentType',
  'status',
  'currentVersion',
  'version',
  'publishDate',
  'updateDate',
  'authors',
]);

/** Member detail. */
function renderMemberDetail(item: Record<string, unknown>): string {
  const name =
    s(item, 'directOrderName') ??
    s(item, 'invertedOrderName') ??
    s(item, 'bioguideId') ??
    'Unknown';
  const lines = [`# ${name}`];

  const meta = join([
    f('ID', s(item, 'bioguideId')),
    f('Party', s(item, 'partyName') ?? s(item, 'currentParty')),
    f('State', s(item, 'state')),
    item.district != null ? f('District', s(item, 'district')) : undefined,
    f(
      'Currently Serving',
      typeof item.currentMember === 'boolean' ? String(item.currentMember) : undefined,
    ),
    f('Birth Year', s(item, 'birthYear')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);

  const honorific = s(item, 'honorificName');
  if (honorific) lines.push(`**Honorific:** ${honorific}`);

  /** terms may be a direct array or nested as `{item: [...]}`. */
  const rawTerms = item.terms;
  const termsArr: Record<string, unknown>[] | undefined = Array.isArray(rawTerms)
    ? rawTerms
    : rawTerms &&
        typeof rawTerms === 'object' &&
        Array.isArray((rawTerms as Record<string, unknown>).item)
      ? ((rawTerms as Record<string, unknown>).item as Record<string, unknown>[])
      : undefined;

  if (termsArr && termsArr.length > 0) {
    lines.push(`\n**Terms (${termsArr.length}):**`);
    for (const term of termsArr) {
      const chamber = s(term, 'chamber');
      const start = s(term, 'startYear');
      const end = s(term, 'endYear');
      const party = s(term, 'partyName');
      const stateName = s(term, 'stateName');
      const range = start && end ? `${start}–${end}` : start;
      const parts = [chamber, range, party, stateName].filter(Boolean);
      lines.push(`- ${withUnnamedFields(term, parts.join(', '), TERM_ROW_KEYS)}`);
    }
  }

  const partyHistory = item.partyHistory;
  if (Array.isArray(partyHistory) && partyHistory.length > 0) {
    lines.push(`\n**Party History:**`);
    for (const p of partyHistory as Record<string, unknown>[]) {
      const partyName = s(p, 'partyName');
      const start = s(p, 'startYear');
      const end = s(p, 'endYear');
      const range = start && end ? `${start}–${end}` : start;
      const parts = [partyName, range && `(${range})`].filter(Boolean);
      lines.push(`- ${withUnnamedFields(p, parts.join(' '), PARTY_HISTORY_ROW_KEYS)}`);
    }
  }

  const leadership = item.leadership;
  if (Array.isArray(leadership) && leadership.length > 0) {
    lines.push(`\n**Leadership Roles (${leadership.length}):**`);
    for (const l of leadership as Record<string, unknown>[]) {
      const type = s(l, 'type');
      const congress = s(l, 'congress');
      const curated = [type, congress ? `Congress ${congress}` : undefined]
        .filter(Boolean)
        .join(' — ');
      lines.push(`- ${withUnnamedFields(l, curated, LEADERSHIP_ROW_KEYS)}`);
    }
  }

  const subResources: string[] = [];
  for (const key of ['sponsoredLegislation', 'cosponsoredLegislation']) {
    const sub = item[key] as Record<string, unknown> | undefined;
    if (sub && typeof sub.count === 'number' && sub.count > 0) {
      const label = key === 'sponsoredLegislation' ? 'sponsored' : 'cosponsored';
      subResources.push(`${sub.count} ${label}`);
    }
  }
  if (subResources.length) lines.push(`\n**Legislation:** ${subResources.join(', ')}`);

  const url = s(item, 'url');
  if (url) lines.push(`\n**URL:** ${url}`);

  const rest = renderDetailRest(item, HEADER_MEMBER_KEYS);
  if (rest) lines.push('', rest);
  return lines.join('\n');
}

const TERM_ROW_KEYS = new Set(['chamber', 'startYear', 'endYear', 'partyName', 'stateName']);
const PARTY_HISTORY_ROW_KEYS = new Set(['partyName', 'startYear', 'endYear']);
const LEADERSHIP_ROW_KEYS = new Set(['type', 'congress']);

const HEADER_MEMBER_KEYS = new Set([
  'bioguideId',
  'directOrderName',
  'invertedOrderName',
  'honorificName',
  'partyName',
  'currentParty',
  'state',
  'district',
  'currentMember',
  'birthYear',
  'updateDate',
  'terms',
  'partyHistory',
  'leadership',
  'sponsoredLegislation',
  'cosponsoredLegislation',
  'url',
]);

/** Committee list item — name + key fields. Fuzzy-matched rows carry `approximate: true`. */
function renderCommitteeListItem(item: Record<string, unknown>, i: number): string {
  const name = s(item, 'name') ?? s(item, 'systemCode') ?? 'Committee';
  const approx = item.approximate === true ? ' _(approximate match)_' : '';
  const lines = [`### ${i + 1}. ${name}${approx}`];
  const meta = join([
    f('Code', s(item, 'systemCode')),
    f('Chamber', s(item, 'chamber')),
    f('Type', s(item, 'committeeTypeCode')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);
  const url = s(item, 'url');
  if (url) lines.push(`**URL:** ${url}`);
  return withRowRest(item, lines, COMMITTEE_ROW_KEYS);
}

/** `parent` is absent: a subcommittee row's owning committee code has to reach the reader. */
const COMMITTEE_ROW_KEYS = new Set([
  'name',
  'systemCode',
  'chamber',
  'committeeTypeCode',
  'updateDate',
  'url',
  'approximate',
]);

/** Committee report list item — citation-first; upstream omits title and bill ref. */
function renderCommitteeReportListItem(item: Record<string, unknown>, i: number): string {
  const citation = s(item, 'citation');
  const type = s(item, 'type');
  const number = s(item, 'number');
  const part = s(item, 'part');
  const congress = s(item, 'congress');
  const chamber = s(item, 'chamber');
  const updated = s(item, 'updateDate');
  const url = s(item, 'url');

  const heading =
    citation ?? (type && number ? `${type} ${congress ?? ''}-${number}` : 'Committee Report');
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([
    f('Congress', congress),
    f('Chamber', chamber),
    f('Type', type),
    f('Number', number),
    part && part !== '1' ? f('Part', part) : undefined,
    f('Updated', updated),
  ]);
  if (meta) lines.push(meta);
  if (url) lines.push(`**URL:** ${url}`);
  return withRowRest(item, lines, COMMITTEE_REPORT_ROW_KEYS);
}

const COMMITTEE_REPORT_ROW_KEYS = new Set([
  'citation',
  'type',
  'number',
  'part',
  'congress',
  'chamber',
  'updateDate',
  'url',
]);

// ── Document Content (the `content` operation) ──────────────────────

/**
 * One character window of a legislative document's text.
 *
 * The other renderers in this file reshape upstream JSON records; this one
 * carries a document body, so the text is emitted verbatim — no entity work, no
 * whitespace collapsing, no markdown wrapper. GPO's pre-formatted layout (column
 * alignment, indentation, blank-line structure) *is* the document's structure,
 * and a code fence would break on the doubled backticks bill text uses for
 * opening quotation marks.
 *
 * The header states the window in both vocabularies: a 1-based human range, and
 * the 0-based `offset` / `nextOffset` a caller actually feeds back.
 */
function renderDocumentContent(content: Record<string, unknown>): string {
  const total = typeof content.totalCharacters === 'number' ? content.totalCharacters : 0;
  const offset = typeof content.offset === 'number' ? content.offset : 0;
  const text = typeof content.text === 'string' ? content.text : '';
  const nextOffset = typeof content.nextOffset === 'number' ? content.nextOffset : null;
  const truncated = content.truncated === true;

  const title = s(content, 'documentTitle') ?? 'Document';
  const lines = [`# ${title}`];

  const range =
    text.length > 0
      ? `**Characters ${(offset + 1).toLocaleString('en-US')}–${(offset + text.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}**`
      : `**0 characters**`;
  lines.push(
    join([
      f('Format', s(content, 'format')),
      range,
      `**Truncated:** ${truncated}`,
      `offset: ${offset}`,
      nextOffset != null ? `next offset: ${nextOffset}` : '_end of document_',
    ]),
  );

  const sourceUrl = s(content, 'sourceUrl');
  if (sourceUrl) lines.push(`**Source:** ${sourceUrl}`);

  const rest = renderDetailRest(content, DOCUMENT_CONTENT_KEYS);
  if (rest) lines.push('', rest);

  lines.push('', text || '_This document is empty._');
  return lines.join('\n');
}

const DOCUMENT_CONTENT_KEYS = new Set([
  'documentTitle',
  'format',
  'sourceUrl',
  'text',
  'totalCharacters',
  'offset',
  'truncated',
  'nextOffset',
]);

/** The `content` payload, when the result carries one. */
function documentContentOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = result.content;
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined;
}

// ── Per-Tool Format Exports ─────────────────────────────────────────

function makeFormatter(
  detailKeys: string[],
  itemRenderer?: ItemRenderer,
  detailRenderer?: (item: Record<string, unknown>) => string,
): (result: Record<string, unknown>) => TextBlock[] {
  return (result) => {
    if (Array.isArray(result.data)) return tb(renderList(result, itemRenderer));
    for (const key of detailKeys) {
      const detail = result[key];
      if (detail != null) {
        const rendered =
          detailRenderer && typeof detail === 'object' && detail !== null
            ? detailRenderer(detail as Record<string, unknown>)
            : renderDetail(detail);
        return tb(rendered);
      }
    }
    return tb(renderDetail(result));
  };
}

/** Bill browse, detail, and sub-resources (actions, amendments, cosponsors, etc.). */
export function formatBills(result: Record<string, unknown>): TextBlock[] {
  const content = documentContentOf(result);
  if (content) return tb(renderDocumentContent(content));
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    const renderer = firstRecord ? pickBillListRenderer(firstRecord) : undefined;
    return tb(renderList(result, renderer));
  }
  if (result.bill != null) return tb(renderBillDetail(result.bill as Record<string, unknown>));
  return tb(renderDetail(result));
}

/**
 * Bill sub-resource summary item — known shape (no nested `bill.*`, since the
 * caller already has the bill). Reuses `htmlToMarkdown` so `<p>` / `<strong>`
 * survive into the rendered Markdown.
 */
function renderBillSubresourceSummaryItem(item: Record<string, unknown>, i: number): string {
  const named = new Set(BILL_SUMMARY_SUBRESOURCE_ROW_KEYS);
  const version = pick(item, named, 'actionDesc', 'versionCode') ?? 'Summary';
  const actionDate = s(item, 'actionDate');
  const updated = s(item, 'updateDate');
  const lines = [`### ${i + 1}. ${version}`];
  const meta = join([f('Action Date', actionDate), f('Summary Updated', updated)]);
  if (meta) lines.push(meta);

  const text = typeof item.text === 'string' ? htmlToMarkdown(item.text) : '';
  if (text) lines.push('', text);
  return withRowRest(item, lines, named);
}

const BILL_SUMMARY_SUBRESOURCE_ROW_KEYS = ['actionDate', 'updateDate', 'text'];

function pickBillListRenderer(first: Record<string, unknown>): ItemRenderer | undefined {
  if ('title' in first && 'number' in first) return renderBillItem;
  /** Bill text versions: `type` + `formats[]`, no `actionDate`. */
  if ('type' in first && 'formats' in first) return renderBillTextItem;
  /** Bill sub-resource summaries: `actionDesc`/`versionCode` + `text`, no `actionCode`/`sourceSystem`. */
  if ('text' in first && ('actionDesc' in first || 'versionCode' in first)) {
    return renderBillSubresourceSummaryItem;
  }
  /** Actions always ship a `text` body; most also carry actionDate/actionCode/sourceSystem. */
  if (
    'text' in first &&
    ('actionDate' in first || 'actionCode' in first || 'sourceSystem' in first)
  )
    return renderBillActionItem;
  return;
}

/** CRS bill summaries — "what's happening in Congress". */
export const formatSummaries = makeFormatter([], renderSummaryItem);

/**
 * Local bill keyword-search results (congressgov_search_bills) from the FTS
 * mirror. Rows are BM25-ranked; each carries the derived billId for follow-up
 * congressgov_bill_lookup calls and a truncated plain-text summary preview.
 */
function renderSearchBillItem(item: Record<string, unknown>, i: number): string {
  const billType = s(item, 'billType')?.toUpperCase() ?? '';
  const billNumber = s(item, 'billNumber') ?? '';
  const congress = s(item, 'congress') ?? '';
  const title = s(item, 'title') ?? 'Untitled';
  const id = billType && billNumber ? `${billType} ${billNumber}` : '';
  const heading = id ? `${id}: ${title}` : title;
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([
    f('Congress', congress),
    f('Chamber', s(item, 'originChamber')),
    f('Bill ID', s(item, 'billId')),
  ]);
  if (meta) lines.push(meta);

  const actionDate = s(item, 'latestActionDate');
  const actionText = s(item, 'latestActionText');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

  const summary = s(item, 'summaryPreview');
  if (summary) lines.push('', summary);

  return withRowRest(item, lines, SEARCH_BILL_ROW_KEYS);
}

const SEARCH_BILL_ROW_KEYS = new Set([
  'billId',
  'billType',
  'billNumber',
  'congress',
  'title',
  'originChamber',
  'latestActionDate',
  'latestActionText',
  'summaryPreview',
]);

/** Local bill keyword search over the FTS mirror. */
export const formatSearchBills = makeFormatter([], renderSearchBillItem);

/** Member browse, detail, and sponsored/cosponsored legislation. */
export function formatMembers(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    if (firstRecord && 'bioguideId' in firstRecord) return tb(renderList(result, renderMemberItem));
    /** Sponsored/cosponsored may mix bills (type+title) and amendments (amendmentNumber, null type/title).
     * Dispatch per-row so amendments don't render as 'Untitled'. */
    if (firstRecord && ('number' in firstRecord || 'amendmentNumber' in firstRecord)) {
      const dispatch: ItemRenderer = (item, i) =>
        'amendmentNumber' in item && item.amendmentNumber != null
          ? renderAmendmentItem(item, i)
          : renderBillItem(item, i);
      return tb(renderList(result, dispatch));
    }
    return tb(renderList(result));
  }
  if (result.member != null)
    return tb(renderMemberDetail(result.member as Record<string, unknown>));
  return tb(renderDetail(result));
}

/** Pull the committee's display name from nested history when the top-level `name` is missing. */
function extractCommitteeName(committee: Record<string, unknown>): string | undefined {
  const direct = s(committee, 'name');
  if (direct) return direct;
  const history = committee.history;
  if (!Array.isArray(history)) return;
  return s(history[0], 'officialName') ?? s(history[0], 'libraryOfCongressName');
}

/** Committee browse, detail, and sub-resources (bills, reports, nominations). */
export function formatCommittees(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    /** Committee list rows have `systemCode` + `name`. Sub-resource rows
     * (bills/reports/nominations) keep their generic / specialized renderers. */
    if (firstRecord && 'systemCode' in firstRecord && 'name' in firstRecord)
      return tb(renderList(result, renderCommitteeListItem));
    return tb(renderList(result));
  }
  if (result.committee != null) {
    const committee = result.committee as Record<string, unknown>;
    const name = extractCommitteeName(committee);
    const body = renderDetail(committee);
    return tb(name ? `# ${name}\n\n${body}` : body);
  }
  return tb(renderDetail(result));
}

/** Committee reports — list, detail, and text. */
export function formatCommitteeReports(result: Record<string, unknown>): TextBlock[] {
  const content = documentContentOf(result);
  if (content) return tb(renderDocumentContent(content));
  if (Array.isArray(result.data)) return tb(renderList(result, renderCommitteeReportListItem));
  if (Array.isArray(result.text)) {
    const textResult = { data: result.text, pagination: { count: result.text.length } };
    return tb(renderList(textResult, renderCommitteeReportTextItem));
  }
  if (result.report != null) return tb(renderDetail(result.report));
  if (result.text != null) return tb(renderDetail(result.text));
  return tb(renderDetail(result));
}

/** CRS policy analysis reports. */
export function formatCrsReports(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) return tb(renderList(result, renderCrsReportItem));
  if (result.report != null)
    return tb(renderCrsReportDetail(result.report as Record<string, unknown>));
  return tb(renderDetail(result));
}

/** Daily Congressional Record. Dispatches between volumes/issues and flattened articles. */
export function formatDailyRecord(result: Record<string, unknown>): TextBlock[] {
  const content = documentContentOf(result);
  if (content) return tb(renderDocumentContent(content));
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    const renderer =
      firstRecord && ('sectionName' in firstRecord || 'title' in firstRecord)
        ? renderDailyArticleItem
        : renderDailyRecordItem;
    return tb(renderList(result, renderer));
  }
  return tb(renderDetail(result));
}

/** Enacted public and private laws. Upstream /law mirrors /bill, so reuse bill formatters. */
export const formatLaws = makeFormatter(['law'], renderBillItem, renderBillDetail);

/**
 * Roll call votes and member voting positions for both chambers. House payloads
 * come from the Congress.gov JSON API; Senate payloads from the LIS XML feed and
 * carry a `chamber: 'senate'` marker — dispatch to the matching renderer set.
 */
export function formatVotes(result: Record<string, unknown>): TextBlock[] {
  const senate = isSenateResult(result);
  /** `members`: roster in `data[]` with the vote record as a sibling context object. */
  if (Array.isArray(result.data) && result.vote != null)
    return tb(senate ? renderSenateVoteMembers(result) : renderVoteMembers(result));
  if (Array.isArray(result.data))
    return tb(renderList(result, senate ? renderSenateVoteItem : renderRollVoteItem));
  if (result.vote != null)
    return tb(
      senate
        ? renderSenateVoteDetail(result.vote as Record<string, unknown>)
        : renderRollVoteDetail(result.vote as Record<string, unknown>),
    );
  return tb(renderDetail(result));
}

/** Presidential nominations and Senate confirmation pipeline. */
export function formatNominations(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    const renderer = firstRecord
      ? pickNominationListRenderer(firstRecord)
      : renderNominationListItem;
    return tb(renderList(result, renderer));
  }
  if (result.nomination != null)
    return tb(renderNominationDetail(result.nomination as Record<string, unknown>));
  return tb(renderDetail(result));
}

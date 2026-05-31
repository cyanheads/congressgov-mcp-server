/**
 * @fileoverview Rich formatting for MCP tool output.
 *
 * content[] is the only field most LLM clients forward to the model —
 * structuredContent (from output schemas) is for programmatic use and is
 * NOT reliably forwarded. These formatters render complete, structured
 * markdown so the LLM can reason about all returned data.
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
 * Convert upstream HTML (Congress.gov bill summaries are returned with `<p>`,
 * `<strong>`, `<em>`, anchor tags) into readable Markdown that preserves
 * paragraph and emphasis structure.
 */
function htmlToMarkdown(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*\/\s*(strong|b)\s*>/gi, '**')
    .replace(/<\s*(em|i)\s*>/gi, '*')
    .replace(/<\s*\/\s*(em|i)\s*>/gi, '*')
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
      for (const item of val.slice(0, 20)) {
        if (typeof item === 'object' && item) {
          lines.push(`- ${renderInline(item as Record<string, unknown>)}`);
        } else {
          lines.push(`- ${String(item)}`);
        }
      }
      if (val.length > 20) lines.push(`- _...${val.length - 20} more_`);
    } else if (typeof val === 'object') {
      const nested = val as Record<string, unknown>;
      const nKeys = Object.keys(nested);

      // Sub-resource reference: { count, url } → "N available"
      if (nKeys.length <= 2 && 'count' in nested) {
        const count = nested.count as number;
        if (count > 0) lines.push(`**${key}:** ${count} available`);
        continue;
      }

      // latestAction: { actionDate, text }
      if (key === 'latestAction') {
        const date = s(nested, 'actionDate');
        const text = s(nested, 'text');
        lines.push(`**Latest Action:** ${[date, text].filter(Boolean).join(' — ')}`);
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
  // Build heading from common identifier fields
  const id =
    item.type && item.number != null
      ? `${String(item.type).toUpperCase()} ${item.number}`
      : (s(item, 'citation') ?? s(item, 'bioguideId') ?? s(item, 'systemCode'));

  const name =
    s(item, 'title') ??
    s(item, 'name') ??
    s(item, 'fullName') ??
    s(item, 'directOrderName') ??
    s(item, 'description') ??
    s(item, 'question');

  const heading = [id, name].filter(Boolean).join(': ') || 'Item';
  const lines = [`### ${index + 1}. ${heading}`];

  for (const [key, val] of Object.entries(item)) {
    if (val == null || val === '') continue;
    if (HEADING_FIELDS.has(key)) continue;

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
      if (key === 'latestAction') {
        const date = s(val, 'actionDate');
        const text = s(val, 'text');
        lines.push(`**Latest Action:** ${[date, text].filter(Boolean).join(' — ')}`);
      } else {
        lines.push(`**${key}:** ${renderInline(val as Record<string, unknown>)}`);
      }
    } else if (Array.isArray(val) && val.length > 0) {
      if (typeof val[0] === 'string' || typeof val[0] === 'number') {
        lines.push(`**${key}:** ${val.join(', ')}`);
      } else {
        lines.push(`**${key}:** ${val.length} items`);
        for (const sub of val.slice(0, 5)) {
          if (typeof sub === 'object' && sub !== null)
            lines.push(`  - ${renderInline(sub as Record<string, unknown>)}`);
        }
        if (val.length > 5) lines.push(`  - _...${val.length - 5} more_`);
      }
    }
  }

  return lines.join('\n');
}

const HEADING_FIELDS = new Set([
  'type',
  'number',
  'citation',
  'bioguideId',
  'systemCode',
  'title',
  'name',
  'fullName',
  'directOrderName',
  'description',
  'question',
]);

/** Compact inline render of a small object. */
function renderInline(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val == null || val === '') continue;
    if (typeof val === 'string') {
      const cleaned = stripHtml(val, { inline: true });
      const preview = cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
      parts.push(`${key}: ${preview}`);
    } else if (typeof val === 'number' || typeof val === 'boolean') parts.push(`${key}: ${val}`);
  }
  if (parts.length > 0) return parts.join(', ');

  const json = JSON.stringify(obj);
  return json.length > 200 ? `${json.slice(0, 197)}...` : json;
}

// ── Domain-Specific Item Renderers ──────────────────────────────────

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

  if (Array.isArray(item.sponsors) && item.sponsors.length > 0) {
    const sponsors = (item.sponsors as Record<string, unknown>[]).map((sp) => {
      const name = s(sp, 'fullName') ?? s(sp, 'firstName') ?? '?';
      const party = s(sp, 'party') ?? '';
      const state = s(sp, 'state') ?? '';
      return party || state ? `${name} (${[party, state].filter(Boolean).join('-')})` : name;
    });
    lines.push(`**Sponsor:** ${sponsors.join(', ')}`);
  }

  const actionDate = s(item, 'latestAction', 'actionDate');
  const actionText = s(item, 'latestAction', 'text');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

  const updated = s(item, 'updateDate');
  if (updated) lines.push(`**Updated:** ${updated}`);
  if (url) lines.push(`**URL:** ${url}`);

  return lines.join('\n');
}

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

  return lines.join('\n');
}

function renderSummaryItem(item: Record<string, unknown>, i: number): string {
  const billType = s(item, 'bill', 'type')?.toUpperCase() ?? '';
  const billNum = s(item, 'bill', 'number') ?? '';
  const congress = s(item, 'bill', 'congress') ?? '';
  const version = s(item, 'actionDesc') ?? s(item, 'versionCode') ?? '';
  const actionDate = s(item, 'actionDate') ?? '';
  const summaryUpdate = s(item, 'lastSummaryUpdateDate') ?? s(item, 'updateDate') ?? '';
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
  lines.push(`**Bill Title:** ${billTitle ?? 'Not available'}`);

  // The summary text is the critical data — the whole point of this tool
  lines.push('');
  lines.push(text || '_Summary text not available._');
  if (url) lines.push(`\n**URL:** ${url}`);

  return lines.join('\n');
}

function renderCrsReportItem(item: Record<string, unknown>, i: number): string {
  const reportNumber =
    s(item, 'reportNumber') ?? s(item, 'number') ?? s(item, 'id') ?? 'Report number not available';
  const title = s(item, 'title') ?? 'Title not available';
  const updated = s(item, 'updateDate') ?? s(item, 'publishDate') ?? s(item, 'date') ?? '';
  const summary = s(item, 'summary') ?? s(item, 'abstract') ?? '';
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

  return lines.join('\n');
}

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

  return lines.join('\n');
}

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

  return lines.join('\n');
}

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

  return lines.join('\n');
}

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

  return lines.join('\n');
}

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
  return lines.join('\n');
}

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

  const actionDate = s(item, 'latestAction', 'actionDate');
  const actionText = s(item, 'latestAction', 'text');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

  if (url) lines.push(`**URL:** ${url}`);
  return lines.join('\n');
}

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
  return lines.join('\n');
}

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

  const actionDate = s(item, 'latestAction', 'actionDate');
  const actionText = s(item, 'latestAction', 'text');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

  const url = s(item, 'url');
  if (url) lines.push(`**URL:** ${url}`);
  return lines.join('\n');
}

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
  return lines.join('\n');
}

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
  return lines.join('\n');
}

/** Nomination hearing items — shape {chamber, citation, date, jacketNumber, number, partNumber, errata?}. */
function renderNominationHearingItem(item: Record<string, unknown>, i: number): string {
  const citation = s(item, 'citation');
  const number = s(item, 'number');
  const heading = citation ?? (number ? `Hearing ${number}` : 'Hearing');
  const lines = [`### ${i + 1}. ${heading}`];

  const partNumber = s(item, 'partNumber');
  const meta = join([
    f('Chamber', s(item, 'chamber')),
    f('Date', s(item, 'date')?.slice(0, 10)),
    f('Number', number),
    partNumber && partNumber !== '1' && partNumber !== '01' ? f('Part', partNumber) : undefined,
    f('Jacket', s(item, 'jacketNumber')),
    s(item, 'errata') === 'Y' ? '_Errata_' : undefined,
  ]);
  if (meta) lines.push(meta);
  return lines.join('\n');
}

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

  const actionDate = s(item, 'latestAction', 'actionDate');
  const actionText = s(item, 'latestAction', 'text');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

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
    for (const n of nominees.slice(0, 20) as Record<string, unknown>[]) {
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
      lines.push(`- ${parts.join(' — ')}`);
    }
    if (nominees.length > 20) lines.push(`- _...${nominees.length - 20} more_`);
  } else if (s(item, 'partNumber') === '00') {
    /** Parent nominations (partNumber=00) have no nominees array. Sub-resources
     * also return 0 results — they live on the partitioned children (PN851-1, PN851-2, …). */
    lines.push(
      '\n_This is a parent nomination. Individual nominees and confirmation actions live on partitioned children (e.g. `PN851-1`, `PN851-2`). Use the partitioned form for `actions`, `committees`, `hearings`, or `nominees`._',
    );
  }

  const url = s(item, 'url');
  if (url) lines.push(`\n**URL:** ${url}`);
  return lines.join('\n');
}

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
  return lines.join('\n');
}

/** One member's position: "Warren Davidson (R-OH) → Nay". */
function renderMemberVoteRow(r: Record<string, unknown>): string {
  const first = s(r, 'firstName');
  const last = s(r, 'lastName');
  const name = first && last ? `${first} ${last}` : (last ?? first ?? s(r, 'bioguideId') ?? '?');
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
  return `- ${[name, loc, cast ? `→ ${cast}` : undefined].filter(Boolean).join(' ')}`;
}

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

  const actionDate = s(item, 'latestAction', 'actionDate');
  const actionText = s(item, 'latestAction', 'text');
  if (actionDate || actionText)
    lines.push(`**Latest Action:** ${[actionDate, actionText].filter(Boolean).join(' — ')}`);

  const laws = item.laws;
  if (Array.isArray(laws) && laws.length > 0) {
    const cites = (laws as Record<string, unknown>[])
      .map((law) => {
        const num = s(law, 'number');
        const lawType = s(law, 'type');
        return num && lawType ? `${lawType} ${num}` : (num ?? lawType);
      })
      .filter(Boolean);
    if (cites.length) lines.push(`**Law:** ${cites.join(', ')}`);
  }

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
    const recent = termsArr.slice(-5);
    for (const term of recent) {
      const chamber = s(term, 'chamber');
      const start = s(term, 'startYear');
      const end = s(term, 'endYear');
      const party = s(term, 'partyName');
      const stateName = s(term, 'stateName');
      const range = start && end ? `${start}–${end}` : start;
      const parts = [chamber, range, party, stateName].filter(Boolean);
      lines.push(`- ${parts.join(', ')}`);
    }
    if (termsArr.length > 5) lines.push(`- _...${termsArr.length - 5} earlier_`);
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
      lines.push(`- ${parts.join(' ')}`);
    }
  }

  const leadership = item.leadership;
  if (Array.isArray(leadership) && leadership.length > 0) {
    lines.push(`\n**Leadership Roles (${leadership.length}):**`);
    for (const l of leadership.slice(0, 10) as Record<string, unknown>[]) {
      const type = s(l, 'type');
      const congress = s(l, 'congress');
      lines.push(
        `- ${[type, congress ? `Congress ${congress}` : undefined].filter(Boolean).join(' — ')}`,
      );
    }
    if (leadership.length > 10) lines.push(`- _...${leadership.length - 10} more_`);
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
  return lines.join('\n');
}

/** Committee list item — name + key fields. */
function renderCommitteeListItem(item: Record<string, unknown>, i: number): string {
  const name = s(item, 'name') ?? s(item, 'systemCode') ?? 'Committee';
  const lines = [`### ${i + 1}. ${name}`];
  const meta = join([
    f('Code', s(item, 'systemCode')),
    f('Chamber', s(item, 'chamber')),
    f('Type', s(item, 'committeeTypeCode')),
    f('Updated', s(item, 'updateDate')),
  ]);
  if (meta) lines.push(meta);
  const url = s(item, 'url');
  if (url) lines.push(`**URL:** ${url}`);
  return lines.join('\n');
}

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
  return lines.join('\n');
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
  const version = s(item, 'actionDesc') ?? s(item, 'versionCode') ?? 'Summary';
  const actionDate = s(item, 'actionDate');
  const updated = s(item, 'updateDate');
  const lines = [`### ${i + 1}. ${version}`];
  const meta = join([f('Action Date', actionDate), f('Summary Updated', updated)]);
  if (meta) lines.push(meta);

  const text = typeof item.text === 'string' ? htmlToMarkdown(item.text) : '';
  if (text) lines.push('', text);
  return lines.join('\n');
}

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

/** House roll call votes and member voting positions. */
export function formatVotes(result: Record<string, unknown>): TextBlock[] {
  /** `members`: roster in `data[]` with the vote record as a sibling context object. */
  if (Array.isArray(result.data) && result.vote != null) return tb(renderVoteMembers(result));
  if (Array.isArray(result.data)) return tb(renderList(result, renderRollVoteItem));
  if (result.vote != null) return tb(renderRollVoteDetail(result.vote as Record<string, unknown>));
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

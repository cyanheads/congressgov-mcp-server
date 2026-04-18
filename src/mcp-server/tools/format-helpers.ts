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

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Safe deep access with HTML stripping. Handles string and number values. */
function s(obj: unknown, ...path: string[]): string | undefined {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === 'string') return stripHtml(cur);
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

function withResponseNotes(result: Record<string, unknown>, text: string): string {
  if (result.rawResponse == null) return text;
  return [
    text,
    '',
    '_Note: markdown output is summarized for readability. `rawResponse` preserves the full upstream Congress.gov envelope._',
  ].join('\n');
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
  if (items.length === 0) return header;
  const renderer = renderItem ?? renderGenericItem;
  const rendered = items.map((item, i) =>
    typeof item === 'object' && item !== null
      ? renderer(item as Record<string, unknown>, i)
      : `${i + 1}. ${String(item)}`,
  );
  return [header, '', ...rendered].join('\n\n');
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
      const cleaned = stripHtml(val);
      if (cleaned.length > 300) {
        lines.push(`**${key}:**`);
        lines.push(cleaned);
      } else {
        lines.push(`**${key}:** ${cleaned}`);
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
          if (typeof v2 === 'string') lines.push(`  **${k2}:** ${stripHtml(v2)}`);
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
      const cleaned = stripHtml(val);
      if (cleaned.length > 300) {
        lines.push(`**${key}:**`);
        lines.push(cleaned);
      } else {
        lines.push(`**${key}:** ${cleaned}`);
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
      const cleaned = stripHtml(val);
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
  const date = s(item, 'actionDate') ?? '';
  const text = s(item, 'text') ?? '';
  const url = s(item, 'url') ?? s(item, 'bill', 'url');

  const ref = billType && billNum ? `${billType} ${billNum}` : 'Bill reference not available';
  const heading = congress ? `${ref}, Congress ${congress}` : ref;
  const lines = [`### ${i + 1}. ${heading}`];

  const meta = join([f('Version', version), f('Date', date)]);
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
    s(item, 'reportNumber') ?? s(item, 'number') ?? 'Report number not available';
  const title = s(item, 'title') ?? 'Title not available';
  const updated = s(item, 'updateDate') ?? s(item, 'date') ?? '';
  const summary = s(item, 'summary') ?? s(item, 'abstract') ?? '';
  const url = s(item, 'url');

  const lines = [`### ${i + 1}. ${reportNumber}: ${title}`];
  if (updated) lines.push(`**Updated:** ${updated}`);
  lines.push(summary || '_Summary not available._');
  if (url) lines.push(`**URL:** ${url}`);

  return lines.join('\n');
}

// ── Per-Tool Format Exports ─────────────────────────────────────────

function makeFormatter(
  detailKeys: string[],
  itemRenderer?: ItemRenderer,
): (result: Record<string, unknown>) => TextBlock[] {
  return (result) => {
    if (Array.isArray(result.data))
      return tb(withResponseNotes(result, renderList(result, itemRenderer)));
    for (const key of detailKeys) {
      if (result[key] != null) return tb(withResponseNotes(result, renderDetail(result[key])));
    }
    return tb(withResponseNotes(result, renderDetail(result)));
  };
}

/** Bill browse, detail, and sub-resources (actions, amendments, cosponsors, etc.). */
export function formatBills(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    const isBills = !!firstRecord && 'title' in firstRecord && 'number' in firstRecord;
    return tb(withResponseNotes(result, renderList(result, isBills ? renderBillItem : undefined)));
  }
  if (result.bill != null) return tb(withResponseNotes(result, renderDetail(result.bill)));
  return tb(withResponseNotes(result, renderDetail(result)));
}

/** CRS bill summaries — "what's happening in Congress". */
export const formatSummaries = makeFormatter([], renderSummaryItem);

/** Member browse, detail, and sponsored/cosponsored legislation. */
export function formatMembers(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data)) {
    const first = result.data[0];
    const firstRecord =
      typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : undefined;
    if (firstRecord && 'bioguideId' in firstRecord)
      return tb(withResponseNotes(result, renderList(result, renderMemberItem)));
    if (firstRecord && 'number' in firstRecord && 'title' in firstRecord)
      return tb(withResponseNotes(result, renderList(result, renderBillItem)));
    return tb(withResponseNotes(result, renderList(result)));
  }
  if (result.member != null) return tb(withResponseNotes(result, renderDetail(result.member)));
  return tb(withResponseNotes(result, renderDetail(result)));
}

/** Committee browse, detail, and sub-resources (bills, reports, nominations). */
export const formatCommittees = makeFormatter(['committee']);

/** Committee reports — list, detail, and text. */
export const formatCommitteeReports = makeFormatter(['report', 'text']);

/** CRS policy analysis reports. */
export function formatCrsReports(result: Record<string, unknown>): TextBlock[] {
  if (Array.isArray(result.data))
    return tb(withResponseNotes(result, renderList(result, renderCrsReportItem)));
  if (result.report != null) return tb(withResponseNotes(result, renderDetail(result.report)));
  return tb(withResponseNotes(result, renderDetail(result)));
}

/** Daily Congressional Record — volumes, issues, articles. */
export const formatDailyRecord = makeFormatter([]);

/** Enacted public and private laws. */
export const formatLaws = makeFormatter(['law'], renderBillItem);

/** House roll call votes and member voting positions. */
export const formatVotes = makeFormatter(['vote']);

/** Presidential nominations and Senate confirmation pipeline. */
export const formatNominations = makeFormatter(['nomination']);

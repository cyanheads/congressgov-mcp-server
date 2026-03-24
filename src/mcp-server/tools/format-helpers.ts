/**
 * @fileoverview Shared formatting for tool output — lists, details, HTML stripping.
 * @module mcp-server/tools/format-helpers
 */

type TextBlock = { type: 'text'; text: string };

/** Format any tool result into readable text content blocks. */
export function formatResult(result: Record<string, unknown>): TextBlock[] {
  return [{ type: 'text', text: render(result) }];
}

function render(obj: Record<string, unknown>): string {
  // Paginated list: { data: [...], pagination: {...} }
  if (Array.isArray(obj.data) && obj.pagination) {
    const p = obj.pagination as { count: number; nextOffset: number | null };
    const items = obj.data as Record<string, unknown>[];
    const header = `${p.count} total${p.nextOffset != null ? ` | next offset: ${p.nextOffset}` : ''}`;
    if (items.length === 0) return header;
    return [header, '', ...items.map((item, i) => `${i + 1}. ${summarize(item)}`)].join('\n');
  }

  // Single-key wrapper: { bill: {...} }, { issues: [...] }, etc.
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] !== undefined) {
    const val = obj[keys[0]];
    if (Array.isArray(val)) {
      if (val.length === 0) return `No ${keys[0]}.`;
      return val
        .map(
          (item: unknown, i: number) =>
            `${i + 1}. ${typeof item === 'object' && item ? summarize(item as Record<string, unknown>) : String(item)}`,
        )
        .join('\n');
    }
  }

  // Detail object or fallback
  return cleanJson(obj);
}

function summarize(item: Record<string, unknown>): string {
  const parts: string[] = [];

  // Identifier
  if (item.type && item.number) parts.push(`${item.type} ${item.number}`);
  else if (item.citation) parts.push(String(item.citation));
  else if (item.id) parts.push(String(item.id));

  // Name
  const name = item.title ?? item.name ?? item.fullName ?? item.directOrderName ?? item.description;
  if (name) parts.push(stripHtml(String(name)).slice(0, 200));

  // Status
  if (typeof item.latestAction === 'object' && item.latestAction) {
    const a = item.latestAction as Record<string, unknown>;
    parts.push(`[${a.actionDate}: ${a.text}]`);
  } else if (item.actionDate && item.text) {
    parts.push(`${item.actionDate}: ${stripHtml(String(item.text)).slice(0, 150)}`);
  }

  return parts.join(' — ') || JSON.stringify(item).slice(0, 300);
}

function cleanJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === 'string' && val.includes('<') ? stripHtml(val) : val),
    2,
  );
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

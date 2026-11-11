/**
 * @fileoverview Text-version paging as Congress.gov serves it, and the walk that
 * checks a `text` page against the `content` call each row names. Shared by the
 * bill and amendment lookup tests, which run it through the real
 * CongressApiService behind their own fetch stubs.
 * @module tests/helpers/text-versions
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

/** A tool call's result as `runToolContract` resolves it. */
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A text version row as `/…/text` publishes it. */
export interface TextVersionRow {
  date: string | null;
  formats: Array<{ type: string; url: string }>;
  type: string;
}

/**
 * One `/…/text` response body. Congress.gov pages `base` by `offset`/`limit` and,
 * for an enacted bill, appends the Public Law version (`appended`) to every page,
 * past the end included; `count` includes it, and `next` is present while `base`
 * has rows past the page (119th H.R. 1, 118th H.R. 815, 2026-11-11). Bills never
 * enacted and amendments append nothing.
 */
export function textVersionsBody(url: URL, base: TextVersionRow[], appended?: TextVersionRow) {
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 20);
  const page = base.slice(offset, offset + limit);
  return {
    textVersions: appended ? [...page, appended] : page,
    pagination: {
      count: base.length + (appended ? 1 : 0),
      ...(offset + limit < base.length ? { next: 'https://api.congress.gov/v3/next' } : {}),
    },
  };
}

/** One `text` page as both surfaces carried it. */
export interface TextPage {
  offset: number;
  rows: Array<TextVersionRow & { textVersionIndex: number }>;
}

/**
 * Read every `text` page at `limit`, first to last by `pagination.nextOffset`,
 * then one page past the end. Each page's `content[]` headings are checked
 * against its `structuredContent` rows: heading N is the row's stamped
 * `textVersionIndex` N, in the same order.
 */
export async function walkTextPages(
  text: (paging: { limit: number; offset: number }) => Promise<ToolResult>,
  limit: number,
): Promise<TextPage[]> {
  const pages: TextPage[] = [];
  let offset: number | null = 0;
  let count = 0;
  while (offset !== null) {
    if (pages.length > 50) throw new Error('text walk did not terminate');
    const page = await readTextPage(text, { limit, offset });
    count = page.count;
    pages.push(page);
    offset = page.nextOffset;
  }
  pages.push(await readTextPage(text, { limit, offset: count + 1 }));
  return pages;
}

async function readTextPage(
  text: (paging: { limit: number; offset: number }) => Promise<ToolResult>,
  paging: { limit: number; offset: number },
): Promise<TextPage & { count: number; nextOffset: number | null }> {
  const result = await text(paging);
  expect(result.isError, JSON.stringify(paging)).not.toBe(true);
  const structured = result.structuredContent as {
    data: Array<TextVersionRow & { textVersionIndex: number }>;
    pagination: { count: number; nextOffset: number | null };
  };
  const headings = result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
    .split('\n')
    .filter((line) => line.startsWith('### '));
  expect(headings, JSON.stringify(paging)).toEqual(
    structured.data.map((row) => `### textVersionIndex ${row.textVersionIndex}: ${row.type}`),
  );
  return {
    offset: paging.offset,
    rows: structured.data,
    count: structured.pagination.count,
    nextOffset: structured.pagination.nextOffset,
  };
}

/**
 * Every version a walk returned, keyed by the index it was stamped with. Fails
 * when one index heads two different versions.
 */
export function versionsByIndex(pages: TextPage[]): Map<number, TextVersionRow> {
  const byIndex = new Map<number, TextVersionRow>();
  for (const { rows } of pages) {
    for (const { textVersionIndex, ...row } of rows) {
      const seen = byIndex.get(textVersionIndex);
      if (seen) expect(row, `textVersionIndex ${textVersionIndex}`).toEqual(seen);
      else byIndex.set(textVersionIndex, row);
    }
  }
  return byIndex;
}

/**
 * @fileoverview The `text` page the bill and amendment lookups return: each row
 * stamped with the `textVersionIndex` `content` reads it by.
 * @module mcp-server/tools/text-version-index
 */

import { z } from '@cyanheads/mcp-ts-core';

/** `textVersionIndex` on a `text` row. */
export const textVersionIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .describe(
    "The textVersionIndex 'content' takes to read this version: its 0-based position in the whole list, counted across pages.",
  );

/**
 * One `text` page, each row stamped `textVersionIndex = offset + i`.
 *
 * Congress.gov appends an enacted bill's Public Law version to every page of
 * `/bill/{c}/{t}/{n}/text`, past the end included: a copy of the version at
 * index `count − 1` (119th H.R. 1, 118th H.R. 815, 2026-11-11). The service cuts
 * a page to `limit`, which drops the copy from a full page; a row whose stamp
 * would reach `count` is the copy on a page past the end, and is dropped too, so
 * that page comes back empty. Its upstream `next` counts only the other versions,
 * so the next offset is set from `count` instead: a walk at a `limit` that
 * divides `count − 1` would otherwise stop one short of the Public Law version.
 * On pages that append nothing — bills never enacted, amendments — that is the
 * next offset upstream gives.
 */
export function textVersionPage<
  TPage extends {
    data: Array<Record<string, unknown>>;
    pagination: { count: number; nextOffset: number | null };
  },
>(page: TPage, { offset }: { offset: number }): TPage {
  const { count } = page.pagination;
  const data = page.data
    .map((row, i) => ({ ...row, textVersionIndex: offset + i }))
    .filter((row) => row.textVersionIndex < count);
  const end = offset + data.length;
  return {
    ...page,
    data,
    pagination: { ...page.pagination, nextOffset: end < count ? end : null },
  };
}

/**
 * @fileoverview Committee list routes as api.congress.gov pages them — 250 rows
 * a request, `next` while rows remain — and the cross-chamber list's live loss:
 * a page boundary inside a group of rows tied on one update instant leaves one
 * row on no page and repeats another.
 * @module tests/helpers/committee-lists
 */

type Row = Record<string, unknown>;

/** Route bodies for `path` (`/v3/committee/senate`), keyed `${path}?offset=N`, one per 250-row page. */
export function committeeListRoutes(path: string, rows: readonly Row[]): Record<string, unknown> {
  const routes: Record<string, unknown> = {};
  for (let offset = 0; offset === 0 || offset < rows.length; offset += 250) {
    routes[`${path}?offset=${offset}`] = {
      committees: rows.slice(offset, offset + 250),
      pagination: {
        count: rows.length,
        ...(offset + 250 < rows.length ? { next: `https://api.congress.gov${path}` } : {}),
      },
    };
  }
  return routes;
}

/**
 * `rows` as `/committee` serves them live: the same count, with `lost` on no
 * page and the row before it on two, as `no94026591` and `n79043123` were.
 */
export function losingRow(rows: readonly Row[], lost: string): Row[] {
  const at = rows.findIndex((row) => row.systemCode === lost);
  if (at < 1) throw new Error(`fixture: ${lost} must follow another row`);
  return rows.map((row, i) => (i === at ? (rows[i - 1] as Row) : row));
}

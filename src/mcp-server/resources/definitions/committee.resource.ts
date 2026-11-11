/**
 * @fileoverview Resource for fetching committee detail by system code.
 * @module mcp-server/resources/definitions/committee
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { anyLetterCase } from '@/mcp-server/tools/tool-helpers.js';
import { readCommittee } from '@/services/congress-api/committee-roster.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

/**
 * Decode the URI segment once, ahead of the letter-case rewrite, so
 * `%6E79043125` and `%48SJU00` read like `n79043125` and `hsju00` — decoding
 * first keeps an escaped capital (`%48` is `H`) from outliving the lowercase.
 * A malformed escape stays as sent, and its `%` fails the pattern like any
 * other character outside letters and digits.
 */
function decodeCodeSegment(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const committeeResource = resource('congress://committee/{committeeCode}', {
  name: 'committee-detail',
  description: 'Committee detail: name, chamber, subcommittees, history, legislation counts.',
  mimeType: 'application/json',
  params: z.object({
    committeeCode: z
      .preprocess(
        decodeCodeSegment,
        anyLetterCase(
          z
            .string()
            .regex(
              /^[a-z0-9]+$/,
              "Committee system code must be letters and digits only (e.g., 'hsju00' or 'n79043125').",
            ),
        ),
      )
      .describe(
        "Committee system code as congressgov_committee_lookup 'list' rows carry it (e.g., 'hsju00', 'n79043125'), in any letter case.",
      ),
  }),

  async handler(params, ctx) {
    const api = getCongressApi();
    const { value: result, chamber } = await readCommittee(
      params.committeeCode,
      (inChamber) => api.getCommittee(inChamber, params.committeeCode, ctx),
      ctx,
    );
    ctx.log.info('Committee resource fetched', { committeeCode: params.committeeCode, chamber });
    const history = result.committee.history as
      | Array<{ officialName?: string; libraryOfCongressName?: string }>
      | undefined;
    const name = history?.[0]?.officialName ?? history?.[0]?.libraryOfCongressName ?? null;
    return { name, chamber, ...result.committee };
  },
});

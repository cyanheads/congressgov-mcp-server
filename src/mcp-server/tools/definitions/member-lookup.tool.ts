/**
 * @fileoverview Tool for discovering congressional members and their legislative activity.
 * @module mcp-server/tools/definitions/member-lookup
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { formatMembers } from '@/mcp-server/tools/format-helpers.js';
import { createPaginationSchema, UnknownRecordSchema } from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

const PaginationSchema = createPaginationSchema('Total number of matching members or bills.');

export const memberLookupTool = tool('congressgov_member_lookup', {
  description: `Discover congressional members and their legislative activity. There is no name search — use 'list' with stateCode (optionally with district), with a congress number, or with currentMember=true to find members. Once you have a bioguideId, use 'get' for full profile or 'sponsored'/'cosponsored' for their legislative portfolio.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    operation: z
      .enum(['list', 'get', 'sponsored', 'cosponsored'])
      .describe('Which data to retrieve.'),
    bioguideId: z
      .string()
      .optional()
      .describe(
        "Unique member identifier (e.g., 'P000197'). Required for get/sponsored/cosponsored.",
      ),
    congress: z.number().int().positive().optional().describe('Congress number to filter by.'),
    stateCode: z
      .string()
      .length(2)
      .optional()
      .describe("Two-letter state code (e.g., 'CA', 'TX')."),
    district: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Congressional district number. Requires stateCode. Use 0 for at-large.'),
    currentMember: z
      .boolean()
      .optional()
      .describe(
        'Filter to currently serving members. Omit to include both current and former members.',
      ),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  }),
  output: z
    .object({
      data: z
        .array(z.unknown())
        .optional()
        .describe('Paginated member or legislation results. Preserves upstream item shapes.'),
      pagination: PaginationSchema.optional().describe(
        'Pagination metadata for list, sponsored, and cosponsored operations.',
      ),
      member: UnknownRecordSchema.optional().describe(
        'Member profile detail when operation="get".',
      ),
    })
    .passthrough()
    .refine((result) => (Array.isArray(result.data) && !!result.pagination) || !!result.member, {
      message: 'Expected either paginated list data or a member detail object.',
    })
    .describe('Member data from Congress.gov API.'),
  format: formatMembers,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      if (input.district !== undefined && !input.stateCode) {
        throw new Error(
          "The 'district' parameter requires 'stateCode'. Provide both to look up a specific House representative.",
        );
      }
      if (input.congress !== undefined && (input.stateCode || input.district !== undefined)) {
        throw new Error(
          "Congress.gov does not support combining 'congress' with stateCode or district for member lookups. Use congress-only or stateCode/district-only filters.",
        );
      }
      const result = await api.listMembers(
        {
          congress: input.congress,
          stateCode: input.stateCode,
          district: input.district,
          currentMember: input.currentMember,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Members listed', { count: result.data.length });
      return result;
    }

    if (!input.bioguideId) {
      throw new Error(
        `The '${input.operation}' operation requires bioguideId. Use 'list' with stateCode or congress to discover members.`,
      );
    }

    if (input.operation === 'get') {
      const result = await api.getMember(input.bioguideId, ctx);
      ctx.log.info('Member retrieved', { bioguideId: input.bioguideId });
      return result;
    }

    const type =
      input.operation === 'sponsored' ? 'sponsored-legislation' : 'cosponsored-legislation';
    const result = await api.getMemberLegislation(
      {
        bioguideId: input.bioguideId,
        type,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Member legislation retrieved', {
      bioguideId: input.bioguideId,
      type: input.operation,
    });
    return result;
  },
});

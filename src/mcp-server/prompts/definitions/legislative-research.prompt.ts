/**
 * @fileoverview Prompt providing a research framework for investigating a policy area across Congress.
 * @module mcp-server/prompts/definitions/legislative-research
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const legislativeResearchPrompt = prompt('congressgov_legislative_research', {
  description:
    'Research framework for investigating a policy area across Congress: relevant bills, key members, committee activity, CRS reports, and floor activity.',
  args: z.object({
    topic: z
      .string()
      .describe('Policy topic or area to research (e.g., "AI regulation", "immigration reform").'),
    congress: z
      .string()
      .optional()
      .describe('Congress number to focus on. Defaults to current congress.'),
  }),
  generate: (args) => {
    const congressNote = args.congress
      ? `Focus on the ${args.congress}th Congress.`
      : 'Start with the current congress (use the congress://current resource to find the number).';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Research the topic "${args.topic}" across congressional activity. ${congressNote}

Since the Congress.gov API has no keyword search, use these discovery strategies:

1. **CRS Reports** — Use congressgov_crs_reports to find nonpartisan policy analyses on this topic.
2. **Recent Summaries** — Use congressgov_bill_summaries with a broad date range to find recently summarized bills that may relate to this topic.
3. **Committee Activity** — Identify relevant committees using congressgov_committee_lookup, then check their recent bills and reports.
4. **Key Members** — Identify members known for this policy area, then check their sponsored legislation via congressgov_member_lookup.
5. **Floor Activity** — Check congressgov_daily_record for recent floor debate on the topic.

Synthesize findings into:
- **Landscape** — What legislation is active on this topic? What stage are key bills at?
- **Key Players** — Which members and committees are driving activity?
- **Policy Analysis** — What do CRS reports say about the issues?
- **Recent Activity** — What happened in the last 30 days?
- **Outlook** — What is the likely trajectory for this policy area?`,
        },
      },
    ];
  },
});

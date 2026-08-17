/**
 * @fileoverview Prompt providing a research framework for investigating a policy area across Congress.
 *
 * The discovery plan branches on the mirror configuration, because the two
 * deployments expose different capabilities: with `CONGRESS_MIRROR_ENABLED` the
 * server registers `congressgov_search_bills` and topical discovery is real;
 * without it no registered tool accepts a topic string, and the honest plan is
 * to say so and ask for a seed identifier. Every step names a tool that is
 * registered in that configuration and an operation that accepts the input the
 * step supplies.
 *
 * @module mcp-server/prompts/definitions/legislative-research
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';

/** Shared closing framework — the synthesis half is configuration-independent. */
const SYNTHESIS = `Synthesize findings into:
- **Landscape** — What legislation is active on this topic? What stage are key bills at?
- **Key Players** — Which members and committees are driving activity?
- **Substance** — What do the bill summaries and subject terms actually say?
- **Recent Activity** — What has each bill's latest action been in the last 30 days?
- **Outlook** — What is the likely trajectory for this policy area?`;

/** Discovery plan when the local bill-search mirror is on and search_bills is registered. */
function mirrorPlan(topic: string): string {
  return `Keyword search over the local bill mirror is the one topical entry point — the Congress.gov API has no keyword search, so every other tool browses by congress, date, chamber, or identifier.

1. **Find candidate bills** — Call congressgov_search_bills with "${topic}" as the query. It matches bill titles and CRS summary text over a bounded congress window; it does not match policy area, full bill text, CRS reports, or the Congressional Record. Narrow with congress, billType, or originChamber when the result set is broad; use fewer or broader keywords when it is empty.
2. **Read each candidate** — Each hit carries congress, billType, and billNumber. Pass them to congressgov_bill_lookup with operation='get', then 'summaries', 'subjects', 'actions', 'cosponsors', and 'related' for substance, status, and companion bills.
3. **Follow the sponsors** — Take a bioguideId from the bill's sponsors or its 'cosponsors' rows and call congressgov_member_lookup with operation='get' for the profile or 'sponsored' for the rest of that member's portfolio.
4. **Follow the committees** — Call congressgov_bill_lookup with operation='committees' for the committees a bill was referred to, or congressgov_committee_lookup with operation='list' and a filter matching a committee *name* ("armed services", "energy") — not the topic string — then its 'bills' and 'reports' operations on the resulting system code.

Report the boundary along with the findings: the search covers bill titles and summaries only, so silence from it is not evidence that no CRS analysis or floor debate exists.`;
}

/** Discovery plan when the mirror is off — no registered tool accepts a topic. */
const NO_MIRROR_PLAN = `This deployment cannot search by topic. The Congress.gov API has no keyword search, and this server's optional local bill-search index is turned off (an operator enables it with CONGRESS_MIRROR_ENABLED=true), so no registered tool accepts a topic string. congressgov_crs_reports, congressgov_bill_summaries, and congressgov_daily_record browse by congress, date, or identifier only — scanning them for a topic means reading thousands of unrelated rows.

Ask for one of these seeds before going further, and say why it is needed:
- a bill — congress + bill type + number (e.g. 119, hr, 4765)
- a member — bioguideId (e.g. P000197)
- a committee — name or system code (e.g. "armed services", hsas00)
- a CRS report — report id (e.g. R46991)

From a seed, these steps are executable:
1. **Bill** — congressgov_bill_lookup with operation='get', then 'summaries', 'subjects', 'actions', 'cosponsors', 'committees', and 'related'. Sponsors and related bills are how the search widens without a keyword index.
2. **Member** — congressgov_member_lookup with operation='get', 'sponsored', or 'cosponsored'. There is no member name search; a bioguideId comes from a bill's sponsors or from operation='list' filtered by state and district.
3. **Committee** — congressgov_committee_lookup with operation='list' and a filter matching a committee *name* to resolve a system code, then 'bills' and 'reports' on that code.
4. **CRS report** — congressgov_crs_reports with operation='get' and a known report id.`;

export const legislativeResearchPrompt = prompt('congressgov_legislative_research', {
  description:
    'Research framework for investigating a policy area across Congress: relevant bills, key members, committee activity, and legislative status. The discovery plan reflects whether this deployment can search by keyword.',
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

    const plan = getServerConfig().mirrorEnabled ? mirrorPlan(args.topic) : NO_MIRROR_PLAN;

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Research the topic "${args.topic}" across congressional activity. ${congressNote}

${plan}

${SYNTHESIS}`,
        },
      },
    ];
  },
});

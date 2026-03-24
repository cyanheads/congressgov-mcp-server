/**
 * @fileoverview Prompt providing a structured framework for analyzing a bill.
 * @module mcp-server/prompts/definitions/bill-analysis
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const billAnalysisPrompt = prompt('congressgov_bill_analysis', {
  description:
    'Structured framework for analyzing a bill: summary, sponsors, committee referrals, action timeline, related legislation, and policy implications.',
  args: z.object({
    congress: z.string().describe('Congress number (e.g., 118).'),
    billType: z.string().describe('Bill type code (e.g., hr, s).'),
    billNumber: z.string().describe('Bill number (e.g., 3076).'),
  }),
  generate: (args) => [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Analyze bill ${args.billType.toUpperCase()} ${args.billNumber} from the ${args.congress}th Congress. Use the congressgov_bill_lookup tool to gather data, then provide:

1. **Summary** — What does this bill do? Use the CRS summary if available, otherwise summarize from the bill text.
2. **Sponsors & Cosponsors** — Who introduced it? How many cosponsors? Bipartisan support?
3. **Committee Referrals** — Which committees has it been referred to? Any reported out?
4. **Action Timeline** — Key legislative actions from introduction to current status.
5. **Related Legislation** — Companion bills, related bills, or predecessors in prior congresses.
6. **Policy Implications** — What policy area does this affect? What are the likely impacts?
7. **Outlook** — Based on committee activity, sponsor influence, and legislative history, what is the realistic path forward?

Use these tools as needed:
- congressgov_bill_lookup (operations: get, actions, cosponsors, committees, summaries, text, related)
- congressgov_member_lookup (to understand sponsor/cosponsor profiles)
- congressgov_committee_lookup (to understand committee context)`,
      },
    },
  ],
});

#!/usr/bin/env node

/**
 * @fileoverview congressgov-mcp-server entry point — Congress.gov API v3 for MCP.
 * @module index
 */

import type {
  AnyPromptDefinition,
  AnyResourceDefinition,
  AnyToolDefinition,
} from '@cyanheads/mcp-ts-core';
import { createApp } from '@cyanheads/mcp-ts-core';
import { billAnalysisPrompt } from '@/mcp-server/prompts/definitions/bill-analysis.prompt.js';
import { legislativeResearchPrompt } from '@/mcp-server/prompts/definitions/legislative-research.prompt.js';
import { billResource } from '@/mcp-server/resources/definitions/bill.resource.js';
import { billTypesResource } from '@/mcp-server/resources/definitions/bill-types.resource.js';
import { committeeResource } from '@/mcp-server/resources/definitions/committee.resource.js';
import { currentCongressResource } from '@/mcp-server/resources/definitions/current-congress.resource.js';
import { memberResource } from '@/mcp-server/resources/definitions/member.resource.js';
import { billLookupTool } from '@/mcp-server/tools/definitions/bill-lookup.tool.js';
import { billSummariesTool } from '@/mcp-server/tools/definitions/bill-summaries.tool.js';
import { committeeLookupTool } from '@/mcp-server/tools/definitions/committee-lookup.tool.js';
import { committeeReportsTool } from '@/mcp-server/tools/definitions/committee-reports.tool.js';
import { crsReportsTool } from '@/mcp-server/tools/definitions/crs-reports.tool.js';
import { dailyRecordTool } from '@/mcp-server/tools/definitions/daily-record.tool.js';
import { enactedLawsTool } from '@/mcp-server/tools/definitions/enacted-laws.tool.js';
import { memberLookupTool } from '@/mcp-server/tools/definitions/member-lookup.tool.js';
import { rollVotesTool } from '@/mcp-server/tools/definitions/roll-votes.tool.js';
import { senateNominationsTool } from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { initCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initSenateVoteService } from '@/services/senate-lis/senate-vote-service.js';

const REPO_ROOT = 'https://github.com/cyanheads/congressgov-mcp-server';

/**
 * File names strip the `congressgov_` name prefix (e.g. `congressgov_bill_lookup` →
 * `bill-lookup.tool.ts`), so the framework's kebab-of-name derivation doesn't match.
 * This helper supplies the actual path as a sourceUrl override so the landing page
 * view-source links resolve on GitHub.
 */
const srcUrl = (kind: 'tools' | 'resources' | 'prompts', file: string) =>
  `${REPO_ROOT}/blob/main/src/mcp-server/${kind}/definitions/${file}`;

const withSource = <T extends AnyToolDefinition | AnyResourceDefinition | AnyPromptDefinition>(
  def: T,
  kind: 'tools' | 'resources' | 'prompts',
  file: string,
): T => ({ ...def, sourceUrl: srcUrl(kind, file) });

await createApp({
  tools: [
    withSource(billLookupTool, 'tools', 'bill-lookup.tool.ts'),
    withSource(enactedLawsTool, 'tools', 'enacted-laws.tool.ts'),
    withSource(memberLookupTool, 'tools', 'member-lookup.tool.ts'),
    withSource(committeeLookupTool, 'tools', 'committee-lookup.tool.ts'),
    withSource(rollVotesTool, 'tools', 'roll-votes.tool.ts'),
    withSource(senateNominationsTool, 'tools', 'senate-nominations.tool.ts'),
    withSource(billSummariesTool, 'tools', 'bill-summaries.tool.ts'),
    withSource(crsReportsTool, 'tools', 'crs-reports.tool.ts'),
    withSource(committeeReportsTool, 'tools', 'committee-reports.tool.ts'),
    withSource(dailyRecordTool, 'tools', 'daily-record.tool.ts'),
  ],
  resources: [
    withSource(currentCongressResource, 'resources', 'current-congress.resource.ts'),
    withSource(billTypesResource, 'resources', 'bill-types.resource.ts'),
    withSource(memberResource, 'resources', 'member.resource.ts'),
    withSource(billResource, 'resources', 'bill.resource.ts'),
    withSource(committeeResource, 'resources', 'committee.resource.ts'),
  ],
  prompts: [
    withSource(billAnalysisPrompt, 'prompts', 'bill-analysis.prompt.ts'),
    withSource(legislativeResearchPrompt, 'prompts', 'legislative-research.prompt.ts'),
  ],
  instructions: `Use the congressgov_* tools to access U.S. legislative data via the Congress.gov API v3: bills, enacted laws, members, committees, roll call votes, presidential nominations, CRS reports, and the daily Congressional Record. There is no keyword search — browse by congress number, bill/report type, date range, chamber, state, and district. Bills are addressed by congress + billType + billNumber (e.g. 118/hr/1234), members by bioguideId, committees by chamber-prefix codes. congressgov_roll_votes serves both chambers via its 'chamber' parameter — House votes come from the Congress.gov API, Senate votes from the Senate's official LIS feed.`,
  landing: {
    repoRoot: REPO_ROOT,
    tagline: 'U.S. legislative data — bills, votes, members, committees — via MCP.',
    requireAuth: false,
  },
  setup() {
    initCongressApi();
    initSenateVoteService();
  },
});

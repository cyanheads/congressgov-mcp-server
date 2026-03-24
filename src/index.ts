#!/usr/bin/env node
/**
 * @fileoverview congressgov-mcp-server entry point — Congress.gov API v3 for MCP.
 * @module index
 */

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

await createApp({
  tools: [
    billLookupTool,
    enactedLawsTool,
    memberLookupTool,
    committeeLookupTool,
    rollVotesTool,
    senateNominationsTool,
    billSummariesTool,
    crsReportsTool,
    committeeReportsTool,
    dailyRecordTool,
  ],
  resources: [
    currentCongressResource,
    billTypesResource,
    memberResource,
    billResource,
    committeeResource,
  ],
  prompts: [billAnalysisPrompt, legislativeResearchPrompt],
  setup() {
    initCongressApi();
  },
});

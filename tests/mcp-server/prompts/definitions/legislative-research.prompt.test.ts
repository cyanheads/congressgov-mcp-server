/**
 * @fileoverview Tests for congressgov_legislative_research prompt.
 * @module tests/mcp-server/prompts/definitions/legislative-research.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { legislativeResearchPrompt } from '@/mcp-server/prompts/definitions/legislative-research.prompt.js';

describe('legislativeResearchPrompt', () => {
  it('generates a single user message', async () => {
    const args = legislativeResearchPrompt.args!.parse({ topic: 'AI regulation' });
    const messages = await legislativeResearchPrompt.generate(args);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content.type).toBe('text');
  });

  it('includes the topic in the prompt text', async () => {
    const args = legislativeResearchPrompt.args!.parse({ topic: 'immigration reform' });
    const messages = await legislativeResearchPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain('immigration reform');
  });

  it('includes congress number when provided', async () => {
    const args = legislativeResearchPrompt.args!.parse({
      topic: 'climate policy',
      congress: '118',
    });
    const messages = await legislativeResearchPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain('118th Congress');
  });

  it('defaults to current congress when congress is omitted', async () => {
    const args = legislativeResearchPrompt.args!.parse({ topic: 'healthcare' });
    const messages = await legislativeResearchPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain('congress://current');
  });

  it('references discovery tools', async () => {
    const args = legislativeResearchPrompt.args!.parse({ topic: 'AI' });
    const messages = await legislativeResearchPrompt.generate(args);
    const text = (messages[0]!.content as { text: string }).text;
    expect(text).toContain('congressgov_crs_reports');
    expect(text).toContain('congressgov_bill_summaries');
    expect(text).toContain('congressgov_committee_lookup');
    expect(text).toContain('congressgov_member_lookup');
    expect(text).toContain('congressgov_daily_record');
  });
});

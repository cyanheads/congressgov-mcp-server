/**
 * @fileoverview Tests for congressgov_legislative_research prompt.
 * @module tests/mcp-server/prompts/definitions/legislative-research.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { legislativeResearchPrompt } from '@/mcp-server/prompts/definitions/legislative-research.prompt.js';

describe('legislativeResearchPrompt', () => {
  it('generates a single user message', () => {
    const args = legislativeResearchPrompt.args.parse({ topic: 'AI regulation' });
    const messages = legislativeResearchPrompt.generate(args);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.type).toBe('text');
  });

  it('includes the topic in the prompt text', () => {
    const args = legislativeResearchPrompt.args.parse({ topic: 'immigration reform' });
    const messages = legislativeResearchPrompt.generate(args);
    expect(messages[0].content.text).toContain('immigration reform');
  });

  it('includes congress number when provided', () => {
    const args = legislativeResearchPrompt.args.parse({
      topic: 'climate policy',
      congress: '118',
    });
    const messages = legislativeResearchPrompt.generate(args);
    expect(messages[0].content.text).toContain('118th Congress');
  });

  it('defaults to current congress when congress is omitted', () => {
    const args = legislativeResearchPrompt.args.parse({ topic: 'healthcare' });
    const messages = legislativeResearchPrompt.generate(args);
    expect(messages[0].content.text).toContain('congress://current');
  });

  it('references discovery tools', () => {
    const args = legislativeResearchPrompt.args.parse({ topic: 'AI' });
    const text = legislativeResearchPrompt.generate(args)[0].content.text;
    expect(text).toContain('congressgov_crs_reports');
    expect(text).toContain('congressgov_bill_summaries');
    expect(text).toContain('congressgov_committee_lookup');
    expect(text).toContain('congressgov_member_lookup');
    expect(text).toContain('congressgov_daily_record');
  });
});

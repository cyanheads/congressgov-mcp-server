/**
 * @fileoverview Tests for congressgov_bill_analysis prompt.
 * @module tests/mcp-server/prompts/definitions/bill-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { billAnalysisPrompt } from '@/mcp-server/prompts/definitions/bill-analysis.prompt.js';

describe('billAnalysisPrompt', () => {
  it('generates a single user message', () => {
    const args = billAnalysisPrompt.args.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const messages = billAnalysisPrompt.generate(args);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content.type).toBe('text');
  });

  it('includes bill identifiers in the prompt text', () => {
    const args = billAnalysisPrompt.args.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const messages = billAnalysisPrompt.generate(args);
    const text = messages[0].content.text;
    expect(text).toContain('HR');
    expect(text).toContain('3076');
    expect(text).toContain('118');
  });

  it('uppercases the bill type', () => {
    const args = billAnalysisPrompt.args.parse({
      congress: '119',
      billType: 'sjres',
      billNumber: '1',
    });
    const messages = billAnalysisPrompt.generate(args);
    expect(messages[0].content.text).toContain('SJRES');
  });

  it('references required tools', () => {
    const args = billAnalysisPrompt.args.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '1',
    });
    const text = billAnalysisPrompt.generate(args)[0].content.text;
    expect(text).toContain('congressgov_bill_lookup');
    expect(text).toContain('congressgov_member_lookup');
    expect(text).toContain('congressgov_committee_lookup');
  });
});

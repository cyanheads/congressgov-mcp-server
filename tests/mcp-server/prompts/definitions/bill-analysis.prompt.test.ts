/**
 * @fileoverview Tests for congressgov_bill_analysis prompt.
 * @module tests/mcp-server/prompts/definitions/bill-analysis.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { billAnalysisPrompt } from '@/mcp-server/prompts/definitions/bill-analysis.prompt.js';

describe('billAnalysisPrompt', () => {
  it('generates a single user message', async () => {
    const args = billAnalysisPrompt.args!.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const messages = await billAnalysisPrompt.generate(args);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content.type).toBe('text');
  });

  it('includes bill identifiers in the prompt text', async () => {
    const args = billAnalysisPrompt.args!.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '3076',
    });
    const messages = await billAnalysisPrompt.generate(args);
    const text = (messages[0]!.content as { text: string }).text;
    expect(text).toContain('HR');
    expect(text).toContain('3076');
    expect(text).toContain('118');
  });

  it.each([
    ['102', '102nd Congress'],
    ['121', '121st Congress'],
    ['113', '113th Congress'],
  ])('spells congress %s as the %s', async (congress, expected) => {
    const args = billAnalysisPrompt.args!.parse({ congress, billType: 'hr', billNumber: '1' });
    const messages = await billAnalysisPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain(`HR 1 from the ${expected}.`);
  });

  it('keeps a congress written as an ordinal as written', async () => {
    const args = billAnalysisPrompt.args!.parse({
      congress: '118th',
      billType: 'hr',
      billNumber: '1',
    });
    const messages = await billAnalysisPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain(
      'HR 1 from the 118th Congress.',
    );
  });

  it('uppercases the bill type', async () => {
    const args = billAnalysisPrompt.args!.parse({
      congress: '119',
      billType: 'sjres',
      billNumber: '1',
    });
    const messages = await billAnalysisPrompt.generate(args);
    expect((messages[0]!.content as { text: string }).text).toContain('SJRES');
  });

  it('references required tools', async () => {
    const args = billAnalysisPrompt.args!.parse({
      congress: '118',
      billType: 'hr',
      billNumber: '1',
    });
    const messages = await billAnalysisPrompt.generate(args);
    const text = (messages[0]!.content as { text: string }).text;
    expect(text).toContain('congressgov_bill_lookup');
    expect(text).toContain('congressgov_member_lookup');
    expect(text).toContain('congressgov_committee_lookup');
  });
});

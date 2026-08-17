/**
 * @fileoverview Tests for congressgov_legislative_research — the discovery plan
 * is configuration-aware, so both mirror states are pinned: with the mirror on,
 * topical discovery routes through congressgov_search_bills; with it off (the
 * default), the prompt says topical discovery is impossible and asks for a seed
 * identifier instead of pointing at browse-only tools.
 *
 * Resolves cyanheads/congressgov-mcp-server#52.
 *
 * @module tests/mcp-server/prompts/definitions/legislative-research.prompt.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { legislativeResearchPrompt } from '@/mcp-server/prompts/definitions/legislative-research.prompt.js';

/** Render the prompt under an explicit mirror configuration. */
async function renderWithMirror(
  mirrorEnabled: boolean,
  args: { topic: string; congress?: string },
): Promise<string> {
  vi.stubEnv('CONGRESS_MIRROR_ENABLED', mirrorEnabled ? 'true' : 'false');
  resetServerConfig();
  const parsed = legislativeResearchPrompt.args!.parse(args);
  const messages = await legislativeResearchPrompt.generate(parsed);
  return (messages[0]!.content as { text: string }).text;
}

/** Every `congressgov_*` tool the rendered plan names. */
function toolsNamed(text: string): string[] {
  return [...new Set(text.match(/congressgov_[a-z_]+/g) ?? [])].sort();
}

/** Registered in every configuration. */
const ALWAYS_REGISTERED = [
  'congressgov_bill_lookup',
  'congressgov_bill_summaries',
  'congressgov_committee_lookup',
  'congressgov_committee_reports',
  'congressgov_crs_reports',
  'congressgov_daily_record',
  'congressgov_enacted_laws',
  'congressgov_member_lookup',
  'congressgov_roll_votes',
  'congressgov_senate_nominations',
];

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('legislativeResearchPrompt — shared shape', () => {
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

  it('keeps the synthesis framework in both configurations', async () => {
    for (const mirrorEnabled of [true, false]) {
      const text = await renderWithMirror(mirrorEnabled, { topic: 'AI regulation' });
      expect(text).toContain('**Landscape**');
      expect(text).toContain('**Key Players**');
      expect(text).toContain('**Outlook**');
    }
  });

  it('never asks the agent to find topical CRS analyses or floor debate', async () => {
    for (const mirrorEnabled of [true, false]) {
      const text = await renderWithMirror(mirrorEnabled, {
        topic: 'rural hospital cybersecurity',
      });
      expect(text).not.toMatch(/congressgov_crs_reports to find/i);
      expect(text).not.toMatch(/congressgov_daily_record for recent floor debate/i);
      expect(text).not.toMatch(/congressgov_bill_summaries with a broad date range/i);
    }
  });
});

describe('legislativeResearchPrompt — mirror enabled', () => {
  it('routes topical bill discovery through congressgov_search_bills', async () => {
    const text = await renderWithMirror(true, { topic: 'semiconductor export controls' });
    expect(text).toContain('congressgov_search_bills');
    const searchIndex = text.indexOf('congressgov_search_bills');
    const lookupIndex = text.indexOf('congressgov_bill_lookup');
    expect(searchIndex).toBeGreaterThan(-1);
    expect(lookupIndex).toBeGreaterThan(searchIndex);
  });

  it('chains the search hit identifiers into the detail tools', async () => {
    const text = await renderWithMirror(true, { topic: 'AI regulation' });
    expect(text).toContain('congressgov_bill_lookup');
    expect(text).toContain('billNumber');
    expect(text).toContain('bioguideId');
  });

  it("states the mirror's coverage boundary rather than overclaiming", async () => {
    const text = await renderWithMirror(true, { topic: 'AI regulation' });
    expect(text).toMatch(/title/i);
    expect(text).toMatch(/summar/i);
    expect(text).toMatch(/Congressional Record/i);
  });

  it('names only registered tools', async () => {
    const text = await renderWithMirror(true, { topic: 'AI regulation' });
    const registered = new Set([...ALWAYS_REGISTERED, 'congressgov_search_bills']);
    for (const name of toolsNamed(text)) expect(registered).toContain(name);
  });
});

describe('legislativeResearchPrompt — mirror disabled', () => {
  it('never names the unregistered congressgov_search_bills tool', async () => {
    const text = await renderWithMirror(false, { topic: 'AI regulation' });
    expect(text).not.toContain('congressgov_search_bills');
  });

  it('states plainly that topical discovery is not possible here', async () => {
    const text = await renderWithMirror(false, { topic: 'rural hospital cybersecurity' });
    expect(text).toMatch(/keyword search/i);
    expect(text).toMatch(/cannot (search|discover)|no (registered )?tool[^.]*accepts/i);
  });

  it('asks for a seed identifier instead of a browse-only scan', async () => {
    const text = await renderWithMirror(false, { topic: 'AI regulation' });
    expect(text).toMatch(/bioguideId/);
    expect(text).toMatch(/billNumber|bill type/i);
    expect(text).toMatch(/committee/i);
  });

  it('names only registered tools', async () => {
    const text = await renderWithMirror(false, { topic: 'AI regulation' });
    const registered = new Set(ALWAYS_REGISTERED);
    for (const name of toolsNamed(text)) expect(registered).toContain(name);
  });

  it('routes every named tool through an operation it actually accepts', async () => {
    const text = await renderWithMirror(false, { topic: 'AI regulation' });
    /** crs_reports has no topical filter — only `get` by report id is executable. */
    if (text.includes('congressgov_crs_reports')) {
      expect(text).toMatch(/congressgov_crs_reports[^.]*(get|report id)/i);
    }
  });
});

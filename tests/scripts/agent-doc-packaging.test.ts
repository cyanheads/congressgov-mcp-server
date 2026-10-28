/**
 * @fileoverview Bundle agent-doc filtering preserves executable dependency subdirectories.
 * @module tests/scripts/agent-doc-packaging.test
 */

import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/** A runtime URL keeps framework-only fallback imports outside the server's typecheck. */
const linter: {
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
} = await import(new URL('../../scripts/lint-packaging.ts', import.meta.url).href);

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/index.js',
  'node_modules/example/dist/framework-skills/index.js',
  'node_modules/example/dist/.claude/index.js',
  'node_modules/example/dist/.agents/index.js',
  'node_modules/example/dist/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/dist/skills/index.mjs',
  'node_modules/@scope/outer/node_modules/inner/lib/skills/index.js',
  'node_modules/outer/node_modules/inner/node_modules/@scope/deep/dist/skills/index.mjs',
  'skills/congressgov-research/SKILL.md',
];

const agentDocEntries = [
  'node_modules/example/skills/research/SKILL.md',
  'node_modules/example/framework-skills/add-tool/SKILL.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/skills/research/SKILL.md',
  'node_modules/example/SKILL.md',
  'node_modules/@scope/example/skills/research/references/guide.md',
  'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
  'node_modules/@scope/example/.claude/settings.json',
  'node_modules/@scope/example/.agents/settings.json',
  'node_modules/@scope/example/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/research/SKILL.md',
  'node_modules/@scope/outer/node_modules/@scope/inner/.agents/settings.json',
  'node_modules/outer/node_modules/@scope/inner/SKILL.md',
  'node_modules/outer/node_modules/inner/node_modules/@scope/deep/framework-skills/add-tool/SKILL.md',
];

describe('dependency agent documentation in MCPB bundles', () => {
  it.each(runtimeEntries)('preserves runtime or published entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(linter.checkBundleEntries([entry], 'fixture.mcpb')).toEqual([]);
  });

  it.each(agentDocEntries)('strips package-root agent entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(linter.checkBundleEntries([entry], 'fixture.mcpb')).toEqual([
      expect.stringContaining('contains 1 node_modules agent-doc entries'),
    ]);
  });
});

# congressgov-mcp-server - Directory Structure

Generated on: 2026-04-19 16:33:54

```text
congressgov-mcp-server/
├── .agents/
├── .claude/
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── docs/
│   └── congress-gov-mcp-design.md
├── scripts/
│   ├── build.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── devcheck/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   └── setup/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── bill-analysis.prompt.ts
│   │   │       └── legislative-research.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── bill-types.resource.ts
│   │   │       ├── bill.resource.ts
│   │   │       ├── committee.resource.ts
│   │   │       ├── current-congress.resource.ts
│   │   │       └── member.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── bill-lookup.tool.ts
│   │       │   ├── bill-summaries.tool.ts
│   │       │   ├── committee-lookup.tool.ts
│   │       │   ├── committee-reports.tool.ts
│   │       │   ├── crs-reports.tool.ts
│   │       │   ├── daily-record.tool.ts
│   │       │   ├── enacted-laws.tool.ts
│   │       │   ├── member-lookup.tool.ts
│   │       │   ├── roll-votes.tool.ts
│   │       │   └── senate-nominations.tool.ts
│   │       ├── format-helpers.ts
│   │       └── tool-helpers.ts
│   ├── services/
│   │   └── congress-api/
│   │       ├── congress-api-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       ├── bill-analysis.prompt.test.ts
│   │   │       └── legislative-research.prompt.test.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── bill-types.resource.test.ts
│   │   │       ├── bill.resource.test.ts
│   │   │       ├── committee.resource.test.ts
│   │   │       ├── current-congress.resource.test.ts
│   │   │       └── member.resource.test.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── bill-lookup.tool.test.ts
│   │       │   ├── bill-summaries.tool.test.ts
│   │       │   ├── committee-lookup.tool.test.ts
│   │       │   ├── committee-reports.tool.test.ts
│   │       │   ├── crs-reports.tool.test.ts
│   │       │   ├── daily-record.tool.test.ts
│   │       │   ├── enacted-laws.tool.test.ts
│   │       │   ├── member-lookup.tool.test.ts
│   │       │   ├── roll-votes.tool.test.ts
│   │       │   └── senate-nominations.tool.test.ts
│   │       └── format-helpers.test.ts
│   └── services/
│       └── congress-api/
│           └── congress-api-service.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

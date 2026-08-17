# congressgov-mcp-server - Directory Structure

Generated on: 2026-08-17 03:46:31

```text
congressgov-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   └── congress-gov-mcp-design.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── congress-mirror-init.ts
│   ├── congress-mirror-refresh.ts
│   ├── congress-mirror-verify.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
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
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
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
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
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
│   │       │   ├── search-bills.tool.ts
│   │       │   └── senate-nominations.tool.ts
│   │       ├── format-helpers.ts
│   │       └── tool-helpers.ts
│   ├── services/
│   │   ├── congress-api/
│   │   │   ├── congress-api-service.ts
│   │   │   └── types.ts
│   │   ├── congress-documents/
│   │   │   ├── congress-documents-service.ts
│   │   │   ├── document-formats.ts
│   │   │   ├── extract-text-stream.ts
│   │   │   ├── extract-text.ts
│   │   │   └── types.ts
│   │   ├── congress-mirror/
│   │   │   ├── congress-mirror-service.ts
│   │   │   ├── ingest.ts
│   │   │   ├── normalize.ts
│   │   │   ├── schema.ts
│   │   │   └── types.ts
│   │   └── senate-lis/
│   │       ├── parse.ts
│   │       ├── senate-vote-service.ts
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
│   │       │   ├── document-content.test.ts
│   │       │   ├── enacted-laws.tool.test.ts
│   │       │   ├── exhausted-page-notice.test.ts
│   │       │   ├── input-validation.test.ts
│   │       │   ├── member-lookup.tool.test.ts
│   │       │   ├── output-fidelity.parity.test.ts
│   │       │   ├── roll-votes.tool.test.ts
│   │       │   ├── search-bills.tool.test.ts
│   │       │   └── senate-nominations.tool.test.ts
│   │       ├── format-helpers-extended.test.ts
│   │       ├── format-helpers-fidelity.test.ts
│   │       ├── format-helpers-list-fidelity.test.ts
│   │       ├── format-helpers.test.ts
│   │       ├── senate-votes.format.test.ts
│   │       └── tool-helpers.test.ts
│   └── services/
│       ├── congress-api/
│       │   ├── congress-api-service.test.ts
│       │   └── normalizers.test.ts
│       ├── congress-documents/
│       │   ├── congress-documents-service.test.ts
│       │   ├── document-formats.test.ts
│       │   ├── extract-text-stream.test.ts
│       │   └── extract-text.test.ts
│       ├── congress-mirror/
│       │   └── congress-mirror-service.test.ts
│       └── senate-lis/
│           ├── fixtures/
│           │   ├── menu.xml
│           │   ├── vote-amendment.xml
│           │   └── vote-cloture.xml
│           ├── parse.test.ts
│           └── senate-vote-service.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

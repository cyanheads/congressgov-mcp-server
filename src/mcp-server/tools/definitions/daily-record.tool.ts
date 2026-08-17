/**
 * @fileoverview Tool for browsing the daily Congressional Record.
 * @module mcp-server/tools/definitions/daily-record
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

import { formatDailyRecord } from '@/mcp-server/tools/format-helpers.js';
import {
  congressErrorContracts,
  documentErrorContracts,
  documentWindowInput,
  listEnrichment,
  listOrDetail,
  notifyIfNoMatches,
  numericIdentifier,
  toIdentifierNumber,
} from '@/mcp-server/tools/tool-helpers.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';
import { getCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';
import {
  describeFormat,
  selectDocumentUrl,
} from '@/services/congress-documents/document-formats.js';

export const dailyRecordTool = tool('congressgov_daily_record', {
  description: `Browse the daily Congressional Record — floor speeches, debates, and legislative text published each day Congress is in session. Navigation is hierarchical: volumes (via 'list') → issues (via 'issues') → articles (via 'articles'). Use 'list' to find recent volumes, 'issues' to see what's in a volume, and 'articles' to access individual speeches and debate sections. 'articles' lists each article and its format URLs; 'content' then reads one article's actual text, a bounded character window at a time.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [...congressErrorContracts, ...documentErrorContracts],
  input: z.object({
    operation: z
      .enum(['list', 'issues', 'articles', 'content'])
      .describe('Which data to retrieve.'),
    volumeNumber: numericIdentifier(
      "Volume number. Required for 'issues', 'articles', and 'content'. Accepts a number or the digit-string form list rows carry.",
    ).optional(),
    issueNumber: numericIdentifier(
      "Issue number within a volume. Required for 'articles' and 'content'. List rows carry this as a string (e.g. \"109\") — both forms are accepted.",
    ).optional(),
    limit: z.number().int().min(1).max(250).default(20).describe('Results per page (1-250).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    articleIndex: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Which article 'content' reads, 0-based against the issue's whole article sequence — the same absolute position 'articles' pages through with offset. Ignored by other operations.",
      ),
    ...documentWindowInput,
  }),
  output: listOrDetail(
    'content',
    '{text, format, sourceUrl, documentTitle, totalCharacters, offset, truncated, nextOffset} for `content` — one exact character window of an article; absent for `list`, `issues`, and `articles`, which carry `data` + `pagination`.',
  ),
  enrichment: listEnrichment,
  format: formatDailyRecord,

  async handler(input, ctx) {
    const api = getCongressApi();

    if (input.operation === 'list') {
      const result = await api.listDailyRecord({ limit: input.limit, offset: input.offset }, ctx);
      ctx.log.info('Daily record listed');
      ctx.enrich.echo('Congressional Record volumes');
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(ctx, result, 'No Congressional Record volumes found.');
      return result;
    }

    if (!input.volumeNumber) {
      throw validationError(
        `The '${input.operation}' operation requires volumeNumber. Use 'list' to browse available Congressional Record volumes.`,
        { field: 'volumeNumber', operation: input.operation },
      );
    }

    /** List rows carry `volumeNumber`/`issueNumber` as strings; the service takes numbers. */
    const volumeNumber = toIdentifierNumber(input.volumeNumber);

    if (input.operation === 'issues') {
      const result = await api.getDailyIssues(
        {
          volumeNumber,
          limit: input.limit,
          offset: input.offset,
        },
        ctx,
      );
      ctx.log.info('Daily record issues retrieved', { volumeNumber });
      ctx.enrich.echo(`issues for volume ${volumeNumber}`);
      ctx.enrich.total(result.pagination.count);
      notifyIfNoMatches(ctx, result, `No issues found for volume ${volumeNumber}.`);
      return result;
    }

    if (!input.issueNumber) {
      throw validationError(
        `The '${input.operation}' operation requires both volumeNumber and issueNumber. Use 'issues' to see available issues within a volume.`,
        { field: 'issueNumber' },
      );
    }

    const issueNumber = toIdentifierNumber(input.issueNumber);

    if (input.operation === 'content') {
      /** One upstream page of exactly the selected article — not the whole issue. */
      const articles = await api.getDailyArticles(
        { volumeNumber, issueNumber, limit: 1, offset: input.articleIndex },
        ctx,
      );
      const article = articles.data[0];
      if (!article) {
        throw ctx.fail(
          'document_unavailable',
          `No article at index ${input.articleIndex} in volume ${volumeNumber}, issue ${issueNumber} — the issue holds ${articles.pagination.count} article(s).`,
          {
            ...ctx.recoveryFor('document_unavailable'),
            articleIndex: input.articleIndex,
            available: articles.pagination.count,
          },
        );
      }

      /** Articles carry their format links on `text[]`, not `formats[]`. */
      const url = selectDocumentUrl(article.text, input.format);
      if (!url) {
        throw ctx.fail(
          'format_unavailable',
          `This article publishes no '${input.format}' document (looked for ${describeFormat(input.format)}). The Congressional Record publishes Formatted Text and PDF only.`,
          {
            ...ctx.recoveryFor('format_unavailable'),
            format: input.format,
            articleIndex: input.articleIndex,
          },
        );
      }

      const document = await getCongressDocuments().fetchDocument(
        { url, characterOffset: input.characterOffset, characterLimit: input.characterLimit },
        ctx,
      );
      const articleTitle =
        typeof article.title === 'string' && article.title.trim() !== ''
          ? article.title
          : `Volume ${volumeNumber}, issue ${issueNumber}, article ${input.articleIndex}`;
      ctx.log.info('Daily record article content retrieved', {
        volumeNumber,
        issueNumber,
        articleIndex: input.articleIndex,
        format: input.format,
        totalCharacters: document.totalCharacters,
      });
      ctx.enrich.echo(
        `article ${input.articleIndex} of volume ${volumeNumber}, issue ${issueNumber}, ${input.format} characters ${document.offset}–${document.offset + document.text.length}`,
      );
      ctx.enrich.total(document.totalCharacters);
      return {
        content: {
          ...document,
          format: input.format,
          sourceUrl: url,
          documentTitle: articleTitle,
        },
      };
    }

    const result = await api.getDailyArticles(
      {
        volumeNumber,
        issueNumber,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.log.info('Daily record articles retrieved', { volumeNumber, issueNumber });
    ctx.enrich.echo(`articles for volume ${volumeNumber}, issue ${issueNumber}`);
    ctx.enrich.total(result.pagination.count);
    notifyIfNoMatches(
      ctx,
      result,
      `No articles found for volume ${volumeNumber}, issue ${issueNumber}.`,
    );
    return result;
  },
});

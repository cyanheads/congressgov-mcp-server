/**
 * @fileoverview Congress.gov API v3 client — auth, pagination, rate limiting, response normalization.
 * @module services/congress-api/congress-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  BillSubResourceParams,
  CommitteeSubResourceParams,
  CongressDetail,
  DateRangeParams,
  GetBillParams,
  GetCommitteeReportParams,
  GetCrsReportParams,
  GetDailyArticlesParams,
  GetDailyIssuesParams,
  GetLawParams,
  GetMemberLegislationParams,
  GetVoteParams,
  ListBillsParams,
  ListCommitteeReportsParams,
  ListCommitteesParams,
  ListDailyRecordParams,
  ListLawsParams,
  ListMembersParams,
  ListNominationsParams,
  ListSummariesParams,
  ListVotesParams,
  NominationSubResourceParams,
  Pagination,
  PaginationParams,
} from './types.js';

type ApiRecord = Record<string, unknown>;
type EntityResult<TKey extends string> = Record<TKey, ApiRecord> & { rawResponse: ApiRecord };

interface FetchListResult {
  data: unknown[];
  pagination: Pagination;
  rawResponse: ApiRecord;
  [key: string]: unknown;
}

interface RequestContextLike extends Record<string, unknown> {
  operation?: string;
  requestId: string;
  timestamp: string;
}

function isApiRecord(value: unknown): value is ApiRecord {
  return typeof value === 'object' && value !== null;
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (
    typeof AbortSignal !== 'function' ||
    typeof AbortSignal.prototype.throwIfAborted !== 'function' ||
    !value
  ) {
    return false;
  }

  try {
    AbortSignal.prototype.throwIfAborted.call(value);
    return true;
  } catch (error) {
    return !(error instanceof TypeError);
  }
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTML_RESPONSE_RE = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

export class CongressApiService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor() {
    const config = getServerConfig();
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  // --- Bills ---

  listBills(params: ListBillsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.billType
      ? `/bill/${params.congress}/${params.billType}`
      : `/bill/${params.congress}`;
    return this.fetchList(path, 'bills', params, ctx);
  }

  async getBill(params: GetBillParams, ctx?: Context): Promise<EntityResult<'bill'>> {
    const data = await this.get(
      `/bill/${params.congress}/${params.billType}/${params.billNumber}`,
      ctx,
    );
    return { bill: data.bill as ApiRecord, rawResponse: data };
  }

  getBillSubResource(params: BillSubResourceParams, ctx?: Context): Promise<FetchListResult> {
    const path = `/bill/${params.congress}/${params.billType}/${params.billNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params, ctx);
  }

  // --- Laws ---

  listLaws(params: ListLawsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.lawType
      ? `/law/${params.congress}/${params.lawType}`
      : `/law/${params.congress}`;
    return this.fetchList(path, 'bills', params, ctx);
  }

  async getLaw(params: GetLawParams, ctx?: Context): Promise<EntityResult<'law'>> {
    const data = await this.get(
      `/law/${params.congress}/${params.lawType}/${params.lawNumber}`,
      ctx,
    );
    return { law: data.law as ApiRecord, rawResponse: data };
  }

  // --- Members ---

  listMembers(params: ListMembersParams, ctx?: Context): Promise<FetchListResult> {
    if (params.congress !== undefined && (params.stateCode || params.district !== undefined)) {
      throw validationError(
        'Congress.gov does not support combining congress with stateCode or district for member lookups. Use congress-only or stateCode/district-only filters.',
        {
          congress: params.congress,
          stateCode: params.stateCode,
          district: params.district,
        },
      );
    }

    let path = '/member';
    if (params.stateCode) {
      path = `/member/${params.stateCode}`;
      if (params.district !== undefined) path += `/${params.district}`;
    } else if (params.congress) {
      path = `/member/congress/${params.congress}`;
    }
    const extraQuery =
      params.currentMember === undefined
        ? undefined
        : { currentMember: params.currentMember ? 'true' : 'false' };
    return this.fetchList(path, 'members', params, ctx, extraQuery);
  }

  async getMember(bioguideId: string, ctx?: Context): Promise<EntityResult<'member'>> {
    const data = await this.get(`/member/${bioguideId}`, ctx);
    return { member: data.member as ApiRecord, rawResponse: data };
  }

  getMemberLegislation(
    params: GetMemberLegislationParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/member/${params.bioguideId}/${params.type}`;
    const key = params.type.replace('-legislation', 'Legislation');
    return this.fetchList(path, key, params, ctx);
  }

  // --- Committees ---

  listCommittees(params: ListCommitteesParams, ctx?: Context): Promise<FetchListResult> {
    let path = '/committee';
    if (params.congress && params.chamber) path = `/committee/${params.congress}/${params.chamber}`;
    else if (params.congress) path = `/committee/${params.congress}`;
    else if (params.chamber) path = `/committee/${params.chamber}`;
    return this.fetchList(path, 'committees', params, ctx);
  }

  async getCommittee(
    chamber: string,
    committeeCode: string,
    ctx?: Context,
  ): Promise<EntityResult<'committee'>> {
    const data = await this.get(`/committee/${chamber}/${committeeCode}`, ctx);
    return { committee: data.committee as ApiRecord, rawResponse: data };
  }

  getCommitteeSubResource(
    params: CommitteeSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/committee/${params.chamber}/${params.committeeCode}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params, ctx);
  }

  // --- Votes ---

  listVotes(params: ListVotesParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList(
      `/house-vote/${params.congress}/${params.session}`,
      'houseRollCallVotes',
      params,
      ctx,
    );
  }

  async getVote(params: GetVoteParams, ctx?: Context): Promise<EntityResult<'vote'>> {
    const data = await this.get(
      `/house-vote/${params.congress}/${params.session}/${params.voteNumber}`,
      ctx,
    );
    return { vote: (data.houseRollCallVote ?? data) as ApiRecord, rawResponse: data };
  }

  async getVoteMembers(params: GetVoteParams, ctx?: Context): Promise<EntityResult<'vote'>> {
    const data = await this.get(
      `/house-vote/${params.congress}/${params.session}/${params.voteNumber}/members`,
      ctx,
    );
    return { vote: (data.houseRollCallVoteMemberVotes ?? data) as ApiRecord, rawResponse: data };
  }

  // --- Nominations ---

  listNominations(params: ListNominationsParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList(`/nomination/${params.congress}`, 'nominations', params, ctx);
  }

  async getNomination(
    congress: number,
    nominationNumber: string,
    ctx?: Context,
  ): Promise<EntityResult<'nomination'>> {
    const data = await this.get(`/nomination/${congress}/${nominationNumber}`, ctx);
    return { nomination: data.nomination as ApiRecord, rawResponse: data };
  }

  getNominee(
    congress: number,
    nominationNumber: string,
    ordinal: number,
    params?: PaginationParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    return this.fetchList(
      `/nomination/${congress}/${nominationNumber}/${ordinal}`,
      'nominees',
      params,
      ctx,
    );
  }

  getNominationSubResource(
    params: NominationSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/nomination/${params.congress}/${params.nominationNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params, ctx);
  }

  // --- Summaries ---

  listSummaries(params: ListSummariesParams, ctx?: Context): Promise<FetchListResult> {
    let path = '/summaries';
    if (params.congress && params.billType)
      path = `/summaries/${params.congress}/${params.billType}`;
    else if (params.congress) path = `/summaries/${params.congress}`;
    return this.fetchList(path, 'summaries', params, ctx);
  }

  // --- CRS Reports ---

  listCrsReports(params?: PaginationParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList('/crsreport', 'CRSReports', params, ctx);
  }

  async getCrsReport(params: GetCrsReportParams, ctx?: Context): Promise<EntityResult<'report'>> {
    try {
      const data = await this.get(`/crsreport/${params.reportNumber}`, ctx);
      return { report: (data.CRSReport ?? data) as ApiRecord, rawResponse: data };
    } catch (error) {
      const statusCode =
        error instanceof McpError && typeof error.data?.statusCode === 'number'
          ? error.data.statusCode
          : undefined;
      const responseBody =
        error instanceof McpError && typeof error.data?.responseBody === 'string'
          ? error.data.responseBody
          : '';

      if (statusCode === 500 && this.isMissingEntityErrorBody(responseBody)) {
        throw notFound(
          'CRS report not found',
          { reportNumber: params.reportNumber },
          { cause: error },
        );
      }
      throw error;
    }
  }

  // --- Committee Reports ---

  listCommitteeReports(
    params: ListCommitteeReportsParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = params.reportType
      ? `/committee-report/${params.congress}/${params.reportType}`
      : `/committee-report/${params.congress}`;
    return this.fetchList(path, 'reports', params, ctx);
  }

  async getCommitteeReport(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<EntityResult<'report'>> {
    const data = await this.get(
      `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}`,
      ctx,
    );
    const reports = data.committeeReports;
    const report = Array.isArray(reports) ? reports[0] : (reports ?? data);
    if (!report || (typeof report === 'object' && Object.keys(report).length === 0)) {
      throw notFound('Committee report not found', {
        congress: params.congress,
        reportType: params.reportType,
        reportNumber: params.reportNumber,
      });
    }
    return { report: report as ApiRecord, rawResponse: data };
  }

  async getCommitteeReportText(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<{ text: unknown }> {
    const data = await this.get(
      `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}/text`,
      ctx,
    );
    return { text: data.text ?? data['text-versions'] ?? data };
  }

  // --- Daily Congressional Record ---

  listDailyRecord(params?: ListDailyRecordParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList('/daily-congressional-record', 'dailyCongressionalRecord', params, ctx);
  }

  getDailyIssues(params: GetDailyIssuesParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList(
      `/daily-congressional-record/${params.volumeNumber}`,
      'dailyCongressionalRecord',
      params,
      ctx,
    );
  }

  getDailyArticles(params: GetDailyArticlesParams, ctx?: Context): Promise<FetchListResult> {
    const path = `/daily-congressional-record/${params.volumeNumber}/${params.issueNumber}/articles`;
    return this.fetchList(path, 'articles', params, ctx);
  }

  // --- Congress metadata ---

  async getCurrentCongress(ctx?: Context): Promise<CongressDetail> {
    const data = await this.get('/congress/current', ctx);
    return data.congress;
  }

  async getCongress(congress: number, ctx?: Context): Promise<CongressDetail> {
    const data = await this.get(`/congress/${congress}`, ctx);
    return data.congress;
  }

  // --- Internal ---

  private async fetchList(
    path: string,
    listKey: string,
    params?: PaginationParams & Partial<DateRangeParams>,
    ctx?: Context,
    extraQuery?: Record<string, string>,
  ): Promise<FetchListResult> {
    const data = await this.get(path, ctx, this.buildQuery(params, extraQuery));
    const items = this.extractListItems(data[listKey]);
    const pagination = this.extractPagination(data.pagination, items.length, params);
    return { data: items, pagination, rawResponse: data };
  }

  private extractPagination(
    raw: Record<string, unknown> | undefined,
    itemCount: number,
    params?: PaginationParams,
  ): Pagination {
    const count = (raw?.count as number) ?? itemCount;
    const currentOffset = params?.offset ?? 0;
    const limit = params?.limit ?? 20;
    const nextOffset = raw?.next ? currentOffset + limit : null;
    return { count, nextOffset };
  }

  // biome-ignore lint/suspicious/noExplicitAny: API responses are dynamic JSON
  private get(path: string, ctx?: Context, query?: Record<string, string>): Promise<any> {
    this.checkRateLimit();

    const url = this.buildUrl(path, query);
    const operation = `CongressApiService GET ${path}`;
    const requestContext = this.getRequestContext(ctx, operation);
    const signal = this.getAbortSignal(ctx);
    const retryOptions = {
      operation,
      context: requestContext,
      baseDelayMs: BASE_BACKOFF_MS,
      maxRetries: MAX_ATTEMPTS - 1,
      isTransient: (error: unknown) => this.isRetryableError(error),
      ...(signal ? { signal } : {}),
    };

    return withRetry(async () => {
      const response = await this.fetchResponse(url, path, requestContext, signal);
      const data = this.parseJsonResponse(await response.text(), path);
      this.requestCount++;
      return data;
    }, retryOptions);
  }

  private checkRateLimit(): void {
    const now = Date.now();
    if (now - this.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.windowStart = now;
      this.requestCount = 0;
    }
    if (this.requestCount >= RATE_LIMIT_MAX) {
      throw rateLimited(
        'Congress.gov API rate limit reached (5,000 requests/hour). Wait before retrying — the limit resets hourly.',
      );
    }
  }

  private inferListKey(subResource: string): string {
    const mapping: Record<string, string> = {
      actions: 'actions',
      amendments: 'amendments',
      articles: 'articles',
      bills: 'committee-bills',
      committees: 'committees',
      cosponsors: 'cosponsors',
      hearings: 'hearings',
      nominations: 'nominations',
      relatedbills: 'relatedBills',
      reports: 'reports',
      subjects: 'subjects',
      summaries: 'summaries',
      text: 'textVersions',
      titles: 'titles',
    };
    return mapping[subResource] ?? subResource;
  }

  private buildUrl(path: string, query?: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('api_key', this.apiKey);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private buildQuery(
    params?: PaginationParams & Partial<DateRangeParams>,
    extraQuery?: Record<string, string>,
  ): Record<string, string> {
    const query: Record<string, string> = { ...extraQuery };
    if (params?.limit != null) query.limit = String(params.limit);
    if (params?.offset != null) query.offset = String(params.offset);
    if (params?.fromDateTime) query.fromDateTime = params.fromDateTime;
    if (params?.toDateTime) query.toDateTime = params.toDateTime;
    return query;
  }

  private extractListItems(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (!isApiRecord(raw)) return [];

    const nestedItems = Object.values(raw).find(Array.isArray);
    return Array.isArray(nestedItems) ? nestedItems : [];
  }

  private getRequestContext(ctx: Context | undefined, operation: string): RequestContextLike {
    const ctxRecord = ctx as unknown as Record<string, unknown> | undefined;
    const requestId =
      typeof ctxRecord?.requestId === 'string' ? ctxRecord.requestId : 'congress-api-service';
    const timestamp =
      typeof ctxRecord?.timestamp === 'string' ? ctxRecord.timestamp : new Date().toISOString();
    return { operation, requestId, timestamp };
  }

  private getAbortSignal(ctx?: Context): AbortSignal | undefined {
    const signal = ctx?.signal;
    return isNativeAbortSignal(signal) ? signal : undefined;
  }

  private async fetchResponse(
    url: URL,
    path: string,
    requestContext: RequestContextLike,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, requestContext, {
        headers: { Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.ServiceUnavailable) {
        const statusCode =
          typeof error.data?.statusCode === 'number' ? error.data.statusCode : undefined;
        if (statusCode === 404) {
          throw notFound('Congress.gov resource not found', { path }, { cause: error });
        }
        if (statusCode === 429) {
          throw rateLimited(
            'Congress.gov API rate limit reached (5,000 requests/hour). Wait before retrying — the limit resets hourly.',
            { path },
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof McpError) {
      return (
        error.code === JsonRpcErrorCode.ServiceUnavailable ||
        error.code === JsonRpcErrorCode.Timeout
      );
    }

    return true;
  }

  private parseJsonResponse(text: string, path: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw serviceUnavailable('Congress.gov API returned an empty response body.', { path });
    }
    if (HTML_RESPONSE_RE.test(trimmed)) {
      throw serviceUnavailable('Congress.gov API returned HTML instead of JSON.', {
        path,
      });
    }

    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      throw serviceUnavailable(
        'Congress.gov API returned invalid JSON.',
        { path },
        { cause: error },
      );
    }
  }

  private isMissingEntityErrorBody(body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed || HTML_RESPONSE_RE.test(trimmed)) return false;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const message =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.message === 'string'
            ? parsed.message
            : '';
      return /not found|no data/i.test(message);
    } catch {
      return false;
    }
  }
}

let _service: CongressApiService | undefined;

export function initCongressApi(): void {
  _service = new CongressApiService();
}

export function getCongressApi(): CongressApiService {
  if (!_service)
    throw new Error('CongressApiService not initialized — call initCongressApi() in setup()');
  return _service;
}

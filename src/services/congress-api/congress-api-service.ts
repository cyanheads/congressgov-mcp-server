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
type EntityResult<TKey extends string> = Record<TKey, ApiRecord>;

interface FetchListResult {
  data: ApiRecord[];
  pagination: Pagination;
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

/** English ordinal for a congress number — "119" → "119th". */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Normalize upstream casing: bioguideID → bioguideId. */
function normalizeVoteResult(item: ApiRecord): ApiRecord {
  if (!('bioguideID' in item)) return item;
  const { bioguideID, ...rest } = item;
  return { bioguideId: bioguideID, ...rest };
}

/**
 * Normalize CRS report payloads:
 * - `relatedMaterials[].URL` → `url`, then dedupe by URL (upstream returns dupes).
 * - `url` on the report itself ships schemeless (`www.congress.gov/...`) — prepend https.
 */
function normalizeCrsReport(item: ApiRecord): ApiRecord {
  let normalized: ApiRecord = item;

  if (typeof normalized.url === 'string' && /^www\./i.test(normalized.url)) {
    normalized = { ...normalized, url: `https://${normalized.url}` };
  }

  if (Array.isArray(normalized.relatedMaterials)) {
    const seen = new Set<string>();
    const deduped: unknown[] = [];
    for (const entry of normalized.relatedMaterials) {
      let cased: unknown = entry;
      if (isApiRecord(entry) && 'URL' in entry && !('url' in entry)) {
        const { URL: upper, ...rest } = entry;
        cased = { url: upper, ...rest };
      }
      const key = isApiRecord(cased) && typeof cased.url === 'string' ? cased.url : undefined;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      deduped.push(cased);
    }
    normalized = { ...normalized, relatedMaterials: deduped };
  }

  return normalized;
}

/** Normalize upstream casing: cmte_rpt_id → cmteRptId. */
function normalizeCommitteeReport(item: ApiRecord): ApiRecord {
  if (!('cmte_rpt_id' in item)) return item;
  const { cmte_rpt_id: snake, ...rest } = item;
  return { cmteRptId: snake, ...rest };
}

const SPACE_DATE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+00:00$/;

/**
 * Some endpoints (notably `/committee/{c}/{code}/reports`) emit `updateDate` as
 * `"YYYY-MM-DD HH:MM:SS+00:00"` instead of strict ISO-8601. Rewrite to ISO Z form
 * so consumers see a single shape across the surface.
 */
function toIsoZ(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = SPACE_DATE_RE.exec(value);
  return m ? `${m[1]}T${m[2]}Z` : value;
}

function normalizeCommitteeReportSubresource(item: ApiRecord): ApiRecord {
  if (typeof item.updateDate !== 'string') return item;
  const normalized = toIsoZ(item.updateDate);
  return normalized === item.updateDate ? item : { ...item, updateDate: normalized };
}

/**
 * The `/daily-congressional-record/{v}/{i}/articles` endpoint wraps articles
 * in section objects: `[{ name, sectionArticles: [...] }]`. Upstream pagination
 * applies to articles (leaves), so flattening aligns `data.length` with the
 * advertised `pagination.count` and gives each article a `sectionName` field
 * for rendering. Resolves cyanheads/congressgov-mcp-server#3.
 */
function flattenArticleSections(sections: ApiRecord[]): ApiRecord[] {
  const flat: ApiRecord[] = [];
  for (const section of sections) {
    const sectionName = typeof section.name === 'string' ? section.name : undefined;
    const articles = section.sectionArticles;
    if (!Array.isArray(articles)) {
      flat.push(section);
      continue;
    }
    for (const article of articles) {
      if (isApiRecord(article)) {
        flat.push(sectionName ? { sectionName, ...article } : article);
      }
    }
  }
  return flat;
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
    const extraQuery = params.sort ? { sort: params.sort } : undefined;
    return this.fetchList(path, 'bills', params, ctx, extraQuery);
  }

  async getBill(params: GetBillParams, ctx?: Context): Promise<EntityResult<'bill'>> {
    const data = await this.tryNotFound(
      () => this.get(`/bill/${params.congress}/${params.billType}/${params.billNumber}`, ctx),
      `Bill ${params.billType.toUpperCase()} ${params.billNumber} not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
    return { bill: data.bill as ApiRecord };
  }

  getBillSubResource(params: BillSubResourceParams, ctx?: Context): Promise<FetchListResult> {
    const path = `/bill/${params.congress}/${params.billType}/${params.billNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Bill ${params.billType.toUpperCase()} ${params.billNumber} (or its ${params.subResource}) not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
  }

  // --- Laws ---

  listLaws(params: ListLawsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.lawType
      ? `/law/${params.congress}/${params.lawType}`
      : `/law/${params.congress}`;
    return this.fetchList(path, 'bills', params, ctx);
  }

  async getLaw(params: GetLawParams, ctx?: Context): Promise<EntityResult<'law'>> {
    /** Congress.gov returns the law endpoint payload under `bill` — a law is a bill that became law. */
    const data = await this.tryNotFound(
      () => this.get(`/law/${params.congress}/${params.lawType}/${params.lawNumber}`, ctx),
      `${params.lawType === 'pub' ? 'Public' : 'Private'} Law ${params.congress}-${params.lawNumber} not found.`,
      { ...params },
    );
    return { law: data.bill as ApiRecord };
  }

  // --- Members ---

  listMembers(params: ListMembersParams, ctx?: Context): Promise<FetchListResult> {
    const prefix =
      params.congress !== undefined ? `/member/congress/${params.congress}` : '/member';
    let path = prefix;
    if (params.stateCode) {
      path = `${prefix}/${params.stateCode}`;
      if (params.district !== undefined) path += `/${params.district}`;
    }
    const extraQuery =
      params.currentMember === undefined
        ? undefined
        : { currentMember: params.currentMember ? 'true' : 'false' };
    return this.fetchList(path, 'members', params, ctx, extraQuery);
  }

  async getMember(bioguideId: string, ctx?: Context): Promise<EntityResult<'member'>> {
    const data = await this.tryNotFound(
      () => this.get(`/member/${bioguideId}`, ctx),
      `Member ${bioguideId} not found. Bioguide IDs are one letter followed by six digits (e.g., P000197).`,
      { bioguideId },
    );
    return { member: data.member as ApiRecord };
  }

  getMemberLegislation(
    params: GetMemberLegislationParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/member/${params.bioguideId}/${params.type}`;
    const key = params.type.replace('-legislation', 'Legislation');
    return this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Member ${params.bioguideId} or their ${params.type.replace('-', ' ')} not found.`,
      { ...params },
    );
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
    const data = await this.tryNotFound(
      () => this.get(`/committee/${chamber}/${committeeCode}`, ctx),
      `Committee ${committeeCode} not found in the ${chamber} chamber.`,
      { chamber, committeeCode },
    );
    return { committee: data.committee as ApiRecord };
  }

  async getCommitteeSubResource(
    params: CommitteeSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/committee/${params.chamber}/${params.committeeCode}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    const result = await this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Committee ${params.committeeCode} (${params.chamber}) or its ${params.subResource} not found.`,
      { ...params },
    );
    if (params.subResource === 'reports') {
      return { ...result, data: result.data.map(normalizeCommitteeReportSubresource) };
    }
    return result;
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
    const data = await this.tryNotFound(
      () => this.get(`/house-vote/${params.congress}/${params.session}/${params.voteNumber}`, ctx),
      `House roll call vote ${params.voteNumber} not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
      { ...params },
    );
    return { vote: (data.houseRollCallVote ?? data) as ApiRecord };
  }

  async getVoteMembers(
    params: GetVoteParams & PaginationParams,
    ctx?: Context,
  ): Promise<EntityResult<'vote'> & { pagination: Pagination }> {
    /** Congress.gov returns the full member list in a single response — the `members` endpoint ignores limit/offset query params — so paginate client-side. */
    const data = await this.tryNotFound(
      () =>
        this.get(
          `/house-vote/${params.congress}/${params.session}/${params.voteNumber}/members`,
          ctx,
        ),
      `House roll call vote ${params.voteNumber} not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
      { ...params },
    );
    const voteRaw = (data.houseRollCallVoteMemberVotes ?? data) as ApiRecord;
    const rawResults = Array.isArray(voteRaw.results) ? voteRaw.results : [];
    const allResults = rawResults.map(normalizeVoteResult);
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    const paged = allResults.slice(offset, offset + limit);
    const nextOffset = offset + paged.length < allResults.length ? offset + paged.length : null;
    return {
      vote: { ...voteRaw, results: paged },
      pagination: { count: allResults.length, nextOffset },
    };
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
    const data = await this.tryNotFound(
      () => this.get(`/nomination/${congress}/${nominationNumber}`, ctx),
      `Nomination PN${nominationNumber} not found in the ${ordinal(congress)} Congress.`,
      { congress, nominationNumber },
    );
    return { nomination: data.nomination as ApiRecord };
  }

  getNominee(
    congress: number,
    nominationNumber: string,
    ordinalNum: number,
    params?: PaginationParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    return this.tryNotFound(
      () =>
        this.fetchList(
          `/nomination/${congress}/${nominationNumber}/${ordinalNum}`,
          'nominees',
          params,
          ctx,
        ),
      `Nominee batch ${ordinalNum} not found on PN${nominationNumber} (${ordinal(congress)} Congress). Use 'get' to see available ordinals on the nomination's nominees array.`,
      { congress, nominationNumber, ordinal: ordinalNum },
    );
  }

  getNominationSubResource(
    params: NominationSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = `/nomination/${params.congress}/${params.nominationNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Nomination PN${params.nominationNumber} (or its ${params.subResource}) not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
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

  async listCrsReports(params?: PaginationParams, ctx?: Context): Promise<FetchListResult> {
    const result = await this.fetchList('/crsreport', 'CRSReports', params, ctx);
    return { ...result, data: result.data.map(normalizeCrsReport) };
  }

  async getCrsReport(params: GetCrsReportParams, ctx?: Context): Promise<EntityResult<'report'>> {
    const data = await this.tryNotFound(
      () => this.get(`/crsreport/${params.reportNumber}`, ctx),
      `CRS report ${params.reportNumber} not found. Report IDs use letter-number codes (e.g., R40097, RL33612, IF12345).`,
      { reportNumber: params.reportNumber },
    );
    const report = (data.CRSReport ?? data) as ApiRecord;
    return { report: normalizeCrsReport(report) as ApiRecord };
  }

  // --- Committee Reports ---

  async listCommitteeReports(
    params: ListCommitteeReportsParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = params.reportType
      ? `/committee-report/${params.congress}/${params.reportType}`
      : `/committee-report/${params.congress}`;
    const result = await this.fetchList(path, 'reports', params, ctx);
    return { ...result, data: result.data.map(normalizeCommitteeReport) };
  }

  async getCommitteeReport(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<EntityResult<'report'>> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}`,
          ctx,
        ),
      `Committee report ${params.reportType.toUpperCase()} ${params.congress}-${params.reportNumber} not found.`,
      { ...params },
    );
    const reports = data.committeeReports;
    const report = Array.isArray(reports) ? reports[0] : (reports ?? data);
    if (!report || (typeof report === 'object' && Object.keys(report).length === 0)) {
      throw notFound(
        `Committee report ${params.reportType.toUpperCase()} ${params.congress}-${params.reportNumber} not found.`,
        { ...params },
      );
    }
    return { report: report as ApiRecord };
  }

  async getCommitteeReportText(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<{ text: unknown }> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}/text`,
          ctx,
        ),
      `Committee report ${params.reportType.toUpperCase()} ${params.congress}-${params.reportNumber} text not found.`,
      { ...params },
    );
    return { text: data.text ?? data['text-versions'] ?? data };
  }

  // --- Daily Congressional Record ---

  listDailyRecord(params?: ListDailyRecordParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList('/daily-congressional-record', 'dailyCongressionalRecord', params, ctx);
  }

  getDailyIssues(params: GetDailyIssuesParams, ctx?: Context): Promise<FetchListResult> {
    return this.tryNotFound(
      () =>
        this.fetchList(
          `/daily-congressional-record/${params.volumeNumber}`,
          'dailyCongressionalRecord',
          params,
          ctx,
        ),
      `Volume ${params.volumeNumber} not found in the daily Congressional Record.`,
      { ...params },
    );
  }

  async getDailyArticles(params: GetDailyArticlesParams, ctx?: Context): Promise<FetchListResult> {
    const path = `/daily-congressional-record/${params.volumeNumber}/${params.issueNumber}/articles`;
    const result = await this.tryNotFound(
      () => this.fetchList(path, 'articles', params, ctx),
      `Issue ${params.issueNumber} of volume ${params.volumeNumber} not found in the daily Congressional Record.`,
      { ...params },
    );
    return { data: flattenArticleSections(result.data), pagination: result.pagination };
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

  /**
   * Run an API call and rewrap upstream "missing entity" responses into an
   * identifier-rich notFound error. Covers both proper 404s and the 500-with-
   * Django-DoesNotExist pattern that some Congress.gov endpoints emit (e.g.
   * committee sub-resources, CRS reports). Other errors propagate unchanged.
   */
  private async tryNotFound<T>(
    fn: () => Promise<T>,
    message: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof McpError) {
        const statusCode =
          typeof error.data?.statusCode === 'number' ? error.data.statusCode : undefined;
        const responseBody =
          typeof error.data?.responseBody === 'string' ? error.data.responseBody : '';
        if (
          error.code === JsonRpcErrorCode.NotFound ||
          (statusCode === 500 && this.isMissingEntityErrorBody(responseBody))
        ) {
          throw notFound(message, data, { cause: error });
        }
      }
      throw error;
    }
  }

  private async fetchList(
    path: string,
    listKey: string,
    params?: PaginationParams & Partial<DateRangeParams>,
    ctx?: Context,
    extraQuery?: Record<string, string>,
  ): Promise<FetchListResult> {
    const data = await this.get(path, ctx, this.buildQuery(params, extraQuery));
    const rawItems = this.extractListItems(data[listKey]);
    /** The /bill/{c}/{t}/{n}/text endpoint always returns limit+1 items —
     * truncate to honor the requested page size and keep pagination consistent. */
    const items =
      params?.limit != null && rawItems.length > params.limit
        ? rawItems.slice(0, params.limit)
        : rawItems;
    const pagination = this.extractPagination(data.pagination, items.length, params);
    return { data: items, pagination };
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
    /** api_key is sent as X-Api-Key header in fetchResponse() — keeping it out of the URL prevents leakage via upstream error messages. */
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('format', 'json');
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

  private extractListItems(raw: unknown): ApiRecord[] {
    const arr = Array.isArray(raw)
      ? raw
      : isApiRecord(raw)
        ? ((Object.values(raw).find(Array.isArray) as unknown[] | undefined) ?? [])
        : [];
    return arr.filter(isApiRecord);
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
        headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      /** fetchWithTimeout maps HTTP status → typed McpError directly (e.g. 429 → RateLimited).
       *  Rewrap RateLimited here to preserve the domain-specific quota message; 404 rewrapping
       *  happens at call sites via tryNotFound() with identifier-rich data. */
      if (error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) {
        throw rateLimited(
          'Congress.gov API rate limit reached (5,000 requests/hour). Wait before retrying — the limit resets hourly.',
          { path },
          { cause: error },
        );
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
      return /not found|no data|does not exist/i.test(message);
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

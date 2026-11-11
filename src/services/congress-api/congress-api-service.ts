/**
 * @fileoverview Congress.gov API v3 client — auth, pagination, rate limiting, response normalization.
 * @module services/congress-api/congress-api-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  defaultIsTransient,
  fetchWithTimeout,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { type BudgetedAttempt, withCallBudget } from '@/services/call-budget.js';
import { ordinal } from '@/utils/congress-calendar.js';
import type {
  AmendmentSubResourceParams,
  BillSubResourceParams,
  CommitteeSubResourceParams,
  CongressDetail,
  DateRangeParams,
  GetAmendmentParams,
  GetBillParams,
  GetCommitteeReportParams,
  GetCrsReportParams,
  GetDailyArticlesParams,
  GetDailyIssuesParams,
  GetLawParams,
  GetMemberLegislationParams,
  GetVoteParams,
  ListAmendmentsParams,
  ListBillsParams,
  ListCommitteeReportsParams,
  ListCommitteesParams,
  ListCrsReportsParams,
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

function isApiRecord(value: unknown): value is ApiRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Tag for an API path: each interpolated value is percent-encoded as exactly one
 * path segment. Encoding leaves an empty value and a dot segment unchanged;
 * `buildUrl` refuses those.
 */
function apiPath(literals: TemplateStringsArray, ...values: Array<string | number>): string {
  return String.raw(literals, ...values.map((value) => encodeURIComponent(value)));
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

/**
 * Flatten the `/bill/{congress}/{billType}/{billNumber}/subjects` container.
 *
 * Congress.gov pairs the paginated `legislativeSubjects[]` with a sibling
 * `policyArea` object that holds the first slot of the same paginated sequence
 * and is counted by `pagination.count`: at `limit=1&offset=0` the response
 * carries the policy area alone, at `offset=1` the first legislative subject.
 * Taking only the array dropped the policy area entirely and left the advertised
 * total above the number of rows a caller could retrieve by walking every page.
 *
 * `subjectType` keeps the two kinds distinguishable now that they share one
 * sequence; the values mirror the upstream key names.
 * Resolves cyanheads/congressgov-mcp-server#47.
 */
function extractSubjectItems(container: ApiRecord): ApiRecord[] {
  const items: ApiRecord[] = [];
  if (isApiRecord(container.policyArea)) {
    items.push({ subjectType: 'policyArea', ...container.policyArea });
  }
  if (Array.isArray(container.legislativeSubjects)) {
    for (const subject of container.legislativeSubjects) {
      if (isApiRecord(subject)) items.push({ subjectType: 'legislativeSubject', ...subject });
    }
  }
  return items;
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
const DEMO_DAILY_WINDOW_MS = 24 * RATE_LIMIT_WINDOW_MS;
/** One attempt of a tool call or resource read, inside the call's 50 s budget (`call-budget.ts`). */
const CALL_ATTEMPT_TIMEOUT_MS = 10_000;
/**
 * One attempt of a request with no call behind it — the mirror ingester. Nothing
 * waits on a client clock there, and an uncached 250-row page of the bill or
 * summaries list can outlast a tool call's 10 s, so it gets the 30 s a document
 * fetch gets.
 */
const UNBUDGETED_ATTEMPT_TIMEOUT_MS = 30_000;
const HTML_RESPONSE_RE = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

const RATE_LIMIT_MESSAGE =
  'Congress.gov API quota reached. Quotas are shared across clients using the same key or demo IP; this server only tracks its own attempts.';

const COMMITTEE_CODE_HINT =
  "Most committee codes are a chamber prefix, letters, and two digits (`hsju00`); some historical ones are not (`n79043125`, `sp2k00`). Call `congressgov_committee_lookup` with `operation: 'list'` and an optional `filter` to discover valid codes.";

/**
 * `data.reason` + `data.recovery.hint` payloads matching the `errors[]` contract
 * declared on every tool (`congressErrorContracts` in tool-helpers). Spread into
 * the factory `data` so each failure is machine-readable on the wire.
 */
const NOT_FOUND_RECOVERY = {
  reason: 'not_found',
  recovery: { hint: 'Use the list or browse operation to find valid identifiers, then retry.' },
} as const;
const RATE_LIMITED_RECOVERY = {
  reason: 'rate_limited',
  recovery: {
    hint: 'Follow Retry-After when supplied; otherwise wait and reduce request frequency. Hourly quotas vary by credential, and DEMO_KEY also has a shared 50-request daily quota.',
  },
} as const;
const INVALID_REQUEST_RECOVERY = {
  reason: 'invalid_request',
  recovery: {
    hint: 'Check parameter formats — dates must be ISO 8601 (2026-05-01T00:00:00Z) and identifiers must match their documented shape.',
  },
} as const;
const API_KEY_REJECTED_RECOVERY = {
  reason: 'api_key_rejected',
  recovery: {
    hint: 'This is a server configuration problem, not a request problem: the operator must replace CONGRESS_API_KEY with a valid api.data.gov key (https://api.data.gov/signup/) or unset it to fall back to the rate-limited DEMO_KEY, then restart the server.',
  },
} as const;
const UPSTREAM_ERROR_RECOVERY = {
  reason: 'upstream_error',
  recovery: {
    hint: 'Retry after a short delay; the Congress.gov service may be temporarily degraded.',
  },
} as const;

/**
 * Read the upstream HTTP status off an McpError's `data`. `fetchWithTimeout`
 * and `httpErrorFromResponse` both emit the Fetch `Response`-aligned `status`;
 * `classifyUpstreamError` re-emits it under the same name so downstream
 * classification reads one vocabulary.
 */
function readUpstreamStatus(error: McpError): number | undefined {
  return typeof error.data?.status === 'number' ? error.data.status : undefined;
}

/**
 * Read the captured upstream response body from the first error in `error`'s
 * cause chain that carries one: the `fetchWithTimeout` error, under the
 * classified error and any retry-exhausted wrapper. The framework keeps that
 * body off every client envelope, so the classified errors never copy it.
 */
function readUpstreamBody(error: McpError): string | undefined {
  for (let current: unknown = error; current instanceof McpError; current = current.cause) {
    if (typeof current.data?.body === 'string') return current.data.body;
  }
  return;
}

/**
 * Read an api.data.gov key-rejection code (`API_KEY_MISSING`, `_INVALID`,
 * `_DISABLED`, `_UNAUTHORIZED`, `_UNVERIFIED`) off a captured error body. The
 * gateway in front of api.congress.gov wraps each in
 * `{ "error": { "code", "message" } }`; Congress.gov's own errors carry a
 * string `error` or plain text and read as none.
 */
function readGatewayKeyCode(body: string | undefined): string | undefined {
  if (!body) return;
  try {
    const parsed: unknown = JSON.parse(body);
    const code = isApiRecord(parsed) && isApiRecord(parsed.error) ? parsed.error.code : undefined;
    return typeof code === 'string' && code.startsWith('API_KEY_') ? code : undefined;
  } catch {
    return;
  }
}

/**
 * Map an McpError raised by fetchWithTimeout — whose message embeds the full
 * upstream URL and which carries no machine-readable reason — into a clean
 * domain error: a stable `data.reason`, an actionable `data.recovery.hint`, and
 * a message that never echoes the request URL. The framework's status-mapped
 * code is preserved for the upstream-error bucket, including cancellation and
 * non-retryable status outcomes. The upstream `status` is carried through and
 * the original error rides as `cause`, so tryNotFound() can still classify the
 * 404 and 500 cases at call sites; the captured body is read from that cause
 * and stays off the client envelope. `timeoutMs` is the failed attempt's own
 * deadline, which an attempt-timeout message names.
 * Resolves cyanheads/congressgov-mcp-server#34.
 */
function classifyUpstreamError(error: McpError, path: string, timeoutMs: number): McpError {
  const status = readUpstreamStatus(error);
  const body = readUpstreamBody(error);
  const meta: Record<string, unknown> = { path };
  if (status !== undefined) meta.status = status;
  if (error.data?.retryable === false) meta.retryable = false;
  if (typeof error.data?.retryAfter === 'string') meta.retryAfter = error.data.retryAfter;
  const opts = { cause: error };
  const suffix = status !== undefined ? ` (HTTP ${status})` : '';

  /** A rejected key and a malformed path segment (#34) both arrive as 403, so the
   *  gateway's body code, not the status, separates operator configuration from
   *  caller input. Resolves cyanheads/congressgov-mcp-server#84. */
  const upstreamCode =
    error.code === JsonRpcErrorCode.Forbidden || error.code === JsonRpcErrorCode.Unauthorized
      ? readGatewayKeyCode(body)
      : undefined;
  if (upstreamCode !== undefined) {
    return configurationError(
      `Congress.gov's api.data.gov gateway rejected the server's API key with ${upstreamCode}${suffix}.`,
      { ...meta, retryable: false, upstreamCode, ...API_KEY_REJECTED_RECOVERY },
      opts,
    );
  }

  switch (error.code) {
    case JsonRpcErrorCode.RequestCancelled:
      return error;
    case JsonRpcErrorCode.Timeout:
      return new McpError(
        error.code,
        status === undefined
          ? `Congress.gov did not complete the request within the ${timeoutMs}-millisecond deadline.`
          : `Congress.gov returned a timeout response${suffix}.`,
        {
          retryable: true,
          ...meta,
          reason: 'upstream_timeout',
          recovery: UPSTREAM_ERROR_RECOVERY.recovery,
        },
        opts,
      );
    case JsonRpcErrorCode.RateLimited:
      return rateLimited(RATE_LIMIT_MESSAGE, { ...meta, ...RATE_LIMITED_RECOVERY }, opts);
    case JsonRpcErrorCode.NotFound:
      return notFound(
        'Congress.gov has no resource matching the request.',
        { ...meta, ...NOT_FOUND_RECOVERY },
        opts,
      );
    case JsonRpcErrorCode.InvalidParams:
    case JsonRpcErrorCode.Forbidden:
    case JsonRpcErrorCode.Unauthorized:
    case JsonRpcErrorCode.ValidationError:
      return invalidParams(
        `Congress.gov rejected the request as malformed${suffix}.`,
        { ...meta, ...INVALID_REQUEST_RECOVERY },
        opts,
      );
    default:
      /** Preserve the framework code while removing the upstream URL from the message. */
      return new McpError(
        error.code,
        `Congress.gov returned an unexpected error${suffix}.`,
        { ...meta, ...UPSTREAM_ERROR_RECOVERY },
        opts,
      );
  }
}

export class CongressApiService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private attempts: number[] = [];
  private hourlyLimit: number;
  private observedRemaining: number | undefined;
  private observedAt = 0;
  private requestSequence = 0;

  constructor() {
    const config = getServerConfig();
    this.apiKey = config.apiKey;
    this.hourlyLimit = this.apiKey === 'DEMO_KEY' ? 30 : 5000;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  // --- Bills ---

  listBills(params: ListBillsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.billType
      ? apiPath`/bill/${params.congress}/${params.billType}`
      : apiPath`/bill/${params.congress}`;
    const extraQuery = params.sort ? { sort: params.sort } : undefined;
    return this.fetchList(path, 'bills', params, ctx, extraQuery);
  }

  async getBill(params: GetBillParams, ctx?: Context): Promise<EntityResult<'bill'>> {
    const data = await this.tryNotFound(
      () =>
        this.get(apiPath`/bill/${params.congress}/${params.billType}/${params.billNumber}`, ctx),
      `Bill ${params.billType.toUpperCase()} ${params.billNumber} not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
    return { bill: data.bill as ApiRecord };
  }

  getBillSubResource(params: BillSubResourceParams, ctx?: Context): Promise<FetchListResult> {
    const path = apiPath`/bill/${params.congress}/${params.billType}/${params.billNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Bill ${params.billType.toUpperCase()} ${params.billNumber} (or its ${params.subResource}) not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
  }

  // --- Amendments ---

  listAmendments(params: ListAmendmentsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.amendmentType
      ? apiPath`/amendment/${params.congress}/${params.amendmentType}`
      : apiPath`/amendment/${params.congress}`;
    const extraQuery = params.sort ? { sort: params.sort } : undefined;
    return this.fetchList(path, 'amendments', params, ctx, extraQuery);
  }

  async getAmendment(
    params: GetAmendmentParams,
    ctx?: Context,
  ): Promise<EntityResult<'amendment'>> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          apiPath`/amendment/${params.congress}/${params.amendmentType}/${params.amendmentNumber}`,
          ctx,
        ),
      `Amendment ${params.amendmentType.toUpperCase()} ${params.amendmentNumber} not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
    return { amendment: data.amendment as ApiRecord };
  }

  getAmendmentSubResource(
    params: AmendmentSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = apiPath`/amendment/${params.congress}/${params.amendmentType}/${params.amendmentNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Amendment ${params.amendmentType.toUpperCase()} ${params.amendmentNumber} (or its ${params.subResource}) not found in the ${ordinal(params.congress)} Congress.`,
      { ...params },
    );
  }

  // --- Laws ---

  listLaws(params: ListLawsParams, ctx?: Context): Promise<FetchListResult> {
    const path = params.lawType
      ? apiPath`/law/${params.congress}/${params.lawType}`
      : apiPath`/law/${params.congress}`;
    return this.fetchList(path, 'bills', params, ctx);
  }

  async getLaw(params: GetLawParams, ctx?: Context): Promise<EntityResult<'law'>> {
    /** Congress.gov returns the law endpoint payload under `bill` — a law is a bill that became law. */
    const data = await this.tryNotFound(
      () => this.get(apiPath`/law/${params.congress}/${params.lawType}/${params.lawNumber}`, ctx),
      `${params.lawType === 'pub' ? 'Public' : 'Private'} Law ${params.congress}-${params.lawNumber} not found.`,
      { ...params },
    );
    return { law: data.bill as ApiRecord };
  }

  // --- Members ---

  listMembers(params: ListMembersParams, ctx?: Context): Promise<FetchListResult> {
    const prefix =
      params.congress !== undefined ? apiPath`/member/congress/${params.congress}` : '/member';
    let path = prefix;
    if (params.stateCode) {
      path += apiPath`/${params.stateCode}`;
      if (params.district !== undefined) path += apiPath`/${params.district}`;
    }
    const extraQuery =
      params.currentMember === undefined
        ? undefined
        : { currentMember: params.currentMember ? 'true' : 'false' };
    return this.fetchList(path, 'members', params, ctx, extraQuery);
  }

  async getMember(bioguideId: string, ctx?: Context): Promise<EntityResult<'member'>> {
    const data = await this.tryNotFound(
      () => this.get(apiPath`/member/${bioguideId}`, ctx),
      `Member ${bioguideId} not found. Bioguide IDs are one letter followed by six digits (e.g., P000197).`,
      { bioguideId },
    );
    return { member: data.member as ApiRecord };
  }

  getMemberLegislation(
    params: GetMemberLegislationParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = apiPath`/member/${params.bioguideId}/${params.type}`;
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
    if (params.congress && params.chamber)
      path = apiPath`/committee/${params.congress}/${params.chamber}`;
    else if (params.congress) path = apiPath`/committee/${params.congress}`;
    else if (params.chamber) path = apiPath`/committee/${params.chamber}`;
    return this.fetchList(path, 'committees', params, ctx);
  }

  async getCommittee(
    chamber: string,
    committeeCode: string,
    ctx?: Context,
  ): Promise<EntityResult<'committee'>> {
    const data = await this.tryNotFound(
      () => this.get(apiPath`/committee/${chamber}/${committeeCode}`, ctx),
      `Committee ${committeeCode} not found in the ${chamber} chamber. ${COMMITTEE_CODE_HINT}`,
      { chamber, committeeCode },
    );
    return { committee: data.committee as ApiRecord };
  }

  async getCommitteeSubResource(
    params: CommitteeSubResourceParams,
    ctx?: Context,
  ): Promise<FetchListResult> {
    const path = apiPath`/committee/${params.chamber}/${params.committeeCode}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    const result = await this.tryNotFound(
      () => this.fetchList(path, key, params, ctx),
      `Committee ${params.committeeCode} (${params.chamber}) or its ${params.subResource} not found. ${COMMITTEE_CODE_HINT}`,
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
      apiPath`/house-vote/${params.congress}/${params.session}`,
      'houseRollCallVotes',
      params,
      ctx,
    );
  }

  async getVote(params: GetVoteParams, ctx?: Context): Promise<EntityResult<'vote'>> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          apiPath`/house-vote/${params.congress}/${params.session}/${params.voteNumber}`,
          ctx,
        ),
      `House roll call vote ${params.voteNumber} not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
      { ...params },
    );
    return { vote: (data.houseRollCallVote ?? data) as ApiRecord };
  }

  async getVoteMembers(
    params: GetVoteParams & PaginationParams,
    ctx?: Context,
  ): Promise<{ data: ApiRecord[]; vote: ApiRecord; pagination: Pagination }> {
    /** Congress.gov returns the full member list in a single response — the `members` endpoint ignores limit/offset query params — so paginate client-side. */
    const data = await this.tryNotFound(
      () =>
        this.get(
          apiPath`/house-vote/${params.congress}/${params.session}/${params.voteNumber}/members`,
          ctx,
        ),
      `House roll call vote ${params.voteNumber} not found in the ${ordinal(params.congress)} Congress, session ${params.session}.`,
      { ...params },
    );
    /** Normalize to the fleet envelope: roster in top-level `data[]`, the vote
     * record as a sibling `vote` (minus `results`, which becomes the page), and
     * `pagination` counting `data`. Aligns `members` with every other paginated
     * op (cyanheads/congressgov-mcp-server#36). */
    const voteRaw = (data.houseRollCallVoteMemberVotes ?? data) as ApiRecord;
    const { results, ...vote } = voteRaw;
    const allResults = (Array.isArray(results) ? results : []).map(normalizeVoteResult);
    const limit = params.limit ?? 20;
    const offset = params.offset ?? 0;
    const paged = allResults.slice(offset, offset + limit);
    const nextOffset = offset + paged.length < allResults.length ? offset + paged.length : null;
    return {
      data: paged,
      vote,
      pagination: { count: allResults.length, nextOffset },
    };
  }

  // --- Nominations ---

  listNominations(params: ListNominationsParams, ctx?: Context): Promise<FetchListResult> {
    return this.fetchList(apiPath`/nomination/${params.congress}`, 'nominations', params, ctx);
  }

  async getNomination(
    congress: number,
    nominationNumber: string,
    ctx?: Context,
  ): Promise<EntityResult<'nomination'>> {
    const data = await this.tryNotFound(
      () => this.get(apiPath`/nomination/${congress}/${nominationNumber}`, ctx),
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
          apiPath`/nomination/${congress}/${nominationNumber}/${ordinalNum}`,
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
    const path = apiPath`/nomination/${params.congress}/${params.nominationNumber}/${params.subResource}`;
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
      path = apiPath`/summaries/${params.congress}/${params.billType}`;
    else if (params.congress) path = apiPath`/summaries/${params.congress}`;
    return this.fetchList(path, 'summaries', params, ctx);
  }

  // --- CRS Reports ---

  async listCrsReports(params?: ListCrsReportsParams, ctx?: Context): Promise<FetchListResult> {
    const result = await this.fetchList('/crsreport', 'CRSReports', params, ctx);
    return { ...result, data: result.data.map(normalizeCrsReport) };
  }

  async getCrsReport(params: GetCrsReportParams, ctx?: Context): Promise<EntityResult<'report'>> {
    const data = await this.tryNotFound(
      () => this.get(apiPath`/crsreport/${params.reportNumber}`, ctx),
      `CRS report ${params.reportNumber} not found. Report IDs are letters then digits (R40097, IF12345) or two digit groups joined by a hyphen (96-548).`,
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
      ? apiPath`/committee-report/${params.congress}/${params.reportType}`
      : apiPath`/committee-report/${params.congress}`;
    const extraQuery =
      params.conference === undefined ? undefined : { conference: String(params.conference) };
    const result = await this.fetchList(path, 'reports', params, ctx, extraQuery);
    return { ...result, data: result.data.map(normalizeCommitteeReport) };
  }

  /**
   * Every record filed under one report number, in upstream order. A multi-part
   * report files each part (and each part's errata) as its own record, in no
   * fixed order; the caller picks the part it serves.
   */
  async getCommitteeReport(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<{ reports: ApiRecord[] }> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          apiPath`/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}`,
          ctx,
        ),
      `Committee report ${params.reportType.toUpperCase()} ${params.congress}-${params.reportNumber} not found.`,
      { ...params },
    );
    const raw = data.committeeReports;
    const reports = (Array.isArray(raw) ? raw : [raw ?? data]).filter(
      (report): report is ApiRecord => isApiRecord(report) && Object.keys(report).length > 0,
    );
    if (reports.length === 0) {
      throw notFound(
        `Committee report ${params.reportType.toUpperCase()} ${params.congress}-${params.reportNumber} not found.`,
        { ...params, ...NOT_FOUND_RECOVERY },
      );
    }
    return { reports };
  }

  async getCommitteeReportText(
    params: GetCommitteeReportParams,
    ctx?: Context,
  ): Promise<{ text: unknown }> {
    const data = await this.tryNotFound(
      () =>
        this.get(
          apiPath`/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}/text`,
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
          apiPath`/daily-congressional-record/${params.volumeNumber}`,
          'dailyCongressionalRecord',
          params,
          ctx,
        ),
      `Volume ${params.volumeNumber} not found in the daily Congressional Record.`,
      { ...params },
    );
  }

  async getDailyArticles(params: GetDailyArticlesParams, ctx?: Context): Promise<FetchListResult> {
    const path = apiPath`/daily-congressional-record/${params.volumeNumber}/${params.issueNumber}/articles`;
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
    const data = await this.get(apiPath`/congress/${congress}`, ctx);
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
        const status = readUpstreamStatus(error);
        const body = readUpstreamBody(error) ?? '';
        if (
          error.code === JsonRpcErrorCode.NotFound ||
          (status === 500 && this.isMissingEntityErrorBody(body))
        ) {
          throw notFound(message, { ...data, ...NOT_FOUND_RECOVERY }, { cause: error });
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
    /**
     * A page longer than `limit` is cut to it. An enacted bill's
     * `/bill/{c}/{t}/{n}/text` appends its Public Law version to every page, a
     * copy of the version at index `count − 1` (`text-version-index.ts`).
     */
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

  /**
   * One request under its call's budget (`call-budget.ts`) when `ctx` is the
   * handler's context, 10 s an attempt; without one — the mirror ingester — the
   * plain ladder, 30 s an attempt. Three attempts either way.
   */
  // biome-ignore lint/suspicious/noExplicitAny: API responses are dynamic JSON
  private get(path: string, ctx?: Context, query?: Record<string, string>): Promise<any> {
    const url = this.buildUrl(path, query);
    const operation = `CongressApiService GET ${path}`;
    const requestContext = this.getRequestContext(ctx, operation);
    const signal = this.getAbortSignal(ctx);

    return withCallBudget(
      async (attempt) => {
        this.reserveAttempt();
        const sequence = ++this.requestSequence;
        const response = await this.fetchResponse(url, path, requestContext, attempt, sequence);
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          if (error instanceof McpError) {
            throw classifyUpstreamError(error, path, attempt.timeoutMs);
          }
          throw error;
        }
        return this.parseJsonResponse(text, path);
      },
      {
        call: ctx,
        attemptTimeoutMs: ctx ? CALL_ATTEMPT_TIMEOUT_MS : UNBUDGETED_ATTEMPT_TIMEOUT_MS,
        upstream: 'Congress.gov',
        request: 'the API response',
        recovery: UPSTREAM_ERROR_RECOVERY.recovery,
        operation,
        context: requestContext,
        baseDelayMs: BASE_BACKOFF_MS,
        maxRetries: MAX_ATTEMPTS - 1,
        isTransient: (error: unknown) => this.isRetryableError(error),
        ...(signal ? { signal } : {}),
      },
    );
  }

  private reserveAttempt(): void {
    const now = Date.now();
    const retention = this.apiKey === 'DEMO_KEY' ? DEMO_DAILY_WINDOW_MS : RATE_LIMIT_WINDOW_MS;
    this.attempts = this.attempts.filter((time) => now - time < retention);
    if (now - this.observedAt >= RATE_LIMIT_WINDOW_MS) this.observedRemaining = undefined;
    const hourlyAttempts = this.attempts.filter((time) => now - time < RATE_LIMIT_WINDOW_MS).length;
    if (
      (this.apiKey === 'DEMO_KEY' && this.attempts.length >= 50) ||
      hourlyAttempts >= this.hourlyLimit ||
      this.observedRemaining === 0
    ) {
      throw rateLimited(RATE_LIMIT_MESSAGE, {
        ...RATE_LIMITED_RECOVERY,
        scope: 'process-local',
        hourlyLimit: this.hourlyLimit,
        ...(this.apiKey === 'DEMO_KEY' ? { dailyLimit: 50 } : {}),
      });
    }
    this.attempts.push(now);
    if (this.observedRemaining !== undefined) this.observedRemaining--;
  }

  /** Observed shared hourly remaining is a conservative bound, never a claimed reset time. */
  private observeQuota(headers: Headers, sequence: number): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    if (limit === null || !/^\d+$/.test(limit)) return;
    const parsedLimit = Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit <= 0) return;
    this.hourlyLimit = parsedLimit;
    if (remaining === null || !/^\d+$/.test(remaining)) return;
    const parsedRemaining = Number(remaining);
    if (!Number.isSafeInteger(parsedRemaining) || parsedRemaining > parsedLimit) return;
    const bound = Math.max(0, parsedRemaining - (this.requestSequence - sequence));
    if (this.observedRemaining === undefined || bound <= this.observedRemaining) {
      this.observedRemaining = bound;
      this.observedAt = Date.now();
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

  /**
   * The request URL for `path`, refusing an empty or dot path segment before any
   * request. Every value reaches here encoded by `apiPath`, whose encoding of `%`
   * rules out the percent-encoded dot forms.
   */
  private buildUrl(path: string, query?: Record<string, string>): URL {
    if (
      path
        .split('/')
        .slice(1)
        .some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw validationError(
        'An identifier in this request is not a path segment Congress.gov can address, so no request was sent. Pass the identifier in the form the tool describes.',
      );
    }
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

  /**
   * Rows out of a list container. Most endpoints hand back a bare array; a few
   * nest one inside an object (`committee-bills` wraps `bills[]` alongside
   * `count`/`url` metadata), and the subjects container splits its rows across
   * an array and a sibling object — see `extractSubjectItems`.
   */
  private extractListItems(raw: unknown): ApiRecord[] {
    if (Array.isArray(raw)) return raw.filter(isApiRecord);
    if (!isApiRecord(raw)) return [];
    if ('legislativeSubjects' in raw || 'policyArea' in raw) return extractSubjectItems(raw);
    const nested = (Object.values(raw).find(Array.isArray) as unknown[] | undefined) ?? [];
    return nested.filter(isApiRecord);
  }

  /**
   * Derive the context the network helpers log and report against. `Context`
   * extends `RequestContext`, so the handler's own context is the parent — the
   * request ID carries through and only the operation label is per-call.
   */
  private getRequestContext(ctx: Context | undefined, operation: string): RequestContext {
    return requestContextService.createRequestContext({
      operation,
      ...(ctx ? { parentContext: ctx } : {}),
    });
  }

  private getAbortSignal(ctx?: Context): AbortSignal | undefined {
    const signal = ctx?.signal;
    return isNativeAbortSignal(signal) ? signal : undefined;
  }

  private async fetchResponse(
    url: URL,
    path: string,
    requestContext: RequestContext,
    attempt: BudgetedAttempt,
    sequence: number,
  ): Promise<Response> {
    try {
      const response = await fetchWithTimeout(url, attempt.timeoutMs, requestContext, {
        headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey },
        errorHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining'],
        /** Congress.gov answers 404 for any identifier it does not hold, which is an
         *  expected outcome on every route here — classifyUpstreamError and
         *  tryNotFound turn it into an actionable domain notFound. Listing it drops
         *  the framework's log severity to debug; the thrown McpError is unchanged. */
        expectedStatuses: [404],
        signal: attempt.signal,
      });
      this.observeQuota(response.headers, sequence);
      return response;
    } catch (error) {
      /** fetchWithTimeout throws a status-mapped McpError whose message embeds the
       *  full upstream URL and which carries no reason/recovery. Rewrap every
       *  non-2xx into a clean, classified domain error (no URL leak). The 404 and
       *  500 DoesNotExist cases are rewrapped again with identifier-rich data at
       *  call sites via tryNotFound(). */
      if (error instanceof McpError) {
        if (error.data?.headers && typeof error.data.headers === 'object') {
          this.observeQuota(new Headers(error.data.headers as Record<string, string>), sequence);
        }
        throw classifyUpstreamError(error, path, attempt.timeoutMs);
      }
      throw error;
    }
  }

  private isRetryableError(error: unknown): boolean {
    return (
      !(error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) &&
      defaultIsTransient(error)
    );
  }

  private parseJsonResponse(text: string, path: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw serviceUnavailable('Congress.gov API returned an empty response body.', {
        path,
        ...UPSTREAM_ERROR_RECOVERY,
      });
    }
    if (HTML_RESPONSE_RE.test(trimmed)) {
      throw serviceUnavailable('Congress.gov API returned HTML instead of JSON.', {
        path,
        ...UPSTREAM_ERROR_RECOVERY,
      });
    }

    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      throw serviceUnavailable(
        'Congress.gov API returned invalid JSON.',
        { path, ...UPSTREAM_ERROR_RECOVERY },
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

/**
 * @fileoverview Congress.gov API v3 client — auth, pagination, rate limiting, response normalization.
 * @module services/congress-api/congress-api-service
 */

import { rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
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

interface FetchListResult {
  data: unknown[];
  pagination: Pagination;
  [key: string]: unknown;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5000;

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

  listBills(params: ListBillsParams): Promise<FetchListResult> {
    const path = params.billType
      ? `/bill/${params.congress}/${params.billType}`
      : `/bill/${params.congress}`;
    return this.fetchList(path, 'bills', params);
  }

  async getBill(params: GetBillParams): Promise<{ bill: unknown }> {
    const data = await this.get(`/bill/${params.congress}/${params.billType}/${params.billNumber}`);
    return { bill: data.bill };
  }

  getBillSubResource(params: BillSubResourceParams): Promise<FetchListResult> {
    const path = `/bill/${params.congress}/${params.billType}/${params.billNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params);
  }

  // --- Laws ---

  listLaws(params: ListLawsParams): Promise<FetchListResult> {
    const path = params.lawType
      ? `/law/${params.congress}/${params.lawType}`
      : `/law/${params.congress}`;
    return this.fetchList(path, 'bills', params);
  }

  async getLaw(params: GetLawParams): Promise<{ law: unknown }> {
    const data = await this.get(`/law/${params.congress}/${params.lawType}/${params.lawNumber}`);
    return { law: data.law };
  }

  // --- Members ---

  listMembers(params: ListMembersParams): Promise<FetchListResult> {
    let path = '/member';
    if (params.congress) path = `/member/congress/${params.congress}`;
    if (params.stateCode) {
      path = `/member/${params.stateCode}`;
      if (params.district !== undefined) path += `/${params.district}`;
    }
    const query: Record<string, string> = {};
    if (params.currentMember !== undefined)
      query.currentMember = params.currentMember ? 'true' : 'false';
    return this.fetchList(path, 'members', params, query);
  }

  async getMember(bioguideId: string): Promise<{ member: unknown }> {
    const data = await this.get(`/member/${bioguideId}`);
    return { member: data.member };
  }

  async getMemberLegislation(
    params: GetMemberLegislationParams,
  ): Promise<{ legislation: unknown[]; pagination: Pagination }> {
    const path = `/member/${params.bioguideId}/${params.type}`;
    const key = params.type.replace('-legislation', 'Legislation');
    const result = await this.fetchList(path, key, params);
    return { legislation: result.data, pagination: result.pagination };
  }

  // --- Committees ---

  listCommittees(params: ListCommitteesParams): Promise<FetchListResult> {
    let path = '/committee';
    if (params.congress && params.chamber) path = `/committee/${params.congress}/${params.chamber}`;
    else if (params.congress) path = `/committee/${params.congress}`;
    else if (params.chamber) path = `/committee/${params.chamber}`;
    return this.fetchList(path, 'committees', params);
  }

  async getCommittee(chamber: string, committeeCode: string): Promise<{ committee: unknown }> {
    const data = await this.get(`/committee/${chamber}/${committeeCode}`);
    return { committee: data.committee };
  }

  getCommitteeSubResource(params: CommitteeSubResourceParams): Promise<FetchListResult> {
    const path = `/committee/${params.chamber}/${params.committeeCode}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params);
  }

  // --- Votes ---

  listVotes(params: ListVotesParams): Promise<FetchListResult> {
    return this.fetchList(
      `/house-vote/${params.congress}/${params.session}`,
      'houseRollCallVotes',
      params,
    );
  }

  async getVote(params: GetVoteParams): Promise<{ vote: unknown }> {
    const data = await this.get(
      `/house-vote/${params.congress}/${params.session}/${params.voteNumber}`,
    );
    return { vote: data.houseRollCallVote ?? data };
  }

  async getVoteMembers(params: GetVoteParams): Promise<{ vote: unknown }> {
    const data = await this.get(
      `/house-vote/${params.congress}/${params.session}/${params.voteNumber}/members`,
    );
    return { vote: data.houseRollCallVoteMemberVotes ?? data };
  }

  // --- Nominations ---

  listNominations(params: ListNominationsParams): Promise<FetchListResult> {
    return this.fetchList(`/nomination/${params.congress}`, 'nominations', params);
  }

  async getNomination(
    congress: number,
    nominationNumber: string,
  ): Promise<{ nomination: unknown }> {
    const data = await this.get(`/nomination/${congress}/${nominationNumber}`);
    return { nomination: data.nomination };
  }

  getNominee(
    congress: number,
    nominationNumber: string,
    ordinal: number,
    params?: PaginationParams,
  ): Promise<FetchListResult> {
    return this.fetchList(
      `/nomination/${congress}/${nominationNumber}/${ordinal}`,
      'nominees',
      params,
    );
  }

  getNominationSubResource(params: NominationSubResourceParams): Promise<FetchListResult> {
    const path = `/nomination/${params.congress}/${params.nominationNumber}/${params.subResource}`;
    const key = this.inferListKey(params.subResource);
    return this.fetchList(path, key, params);
  }

  // --- Summaries ---

  listSummaries(params: ListSummariesParams): Promise<FetchListResult> {
    let path = '/summaries';
    if (params.congress && params.billType)
      path = `/summaries/${params.congress}/${params.billType}`;
    else if (params.congress) path = `/summaries/${params.congress}`;
    return this.fetchList(path, 'summaries', params);
  }

  // --- CRS Reports ---

  listCrsReports(params?: PaginationParams): Promise<FetchListResult> {
    return this.fetchList('/crsreport', 'CRSReports', params);
  }

  async getCrsReport(params: GetCrsReportParams): Promise<{ report: unknown }> {
    const data = await this.get(`/crsreport/${params.reportNumber}`);
    return { report: data.CRSReport ?? data };
  }

  // --- Committee Reports ---

  listCommitteeReports(params: ListCommitteeReportsParams): Promise<FetchListResult> {
    const path = params.reportType
      ? `/committee-report/${params.congress}/${params.reportType}`
      : `/committee-report/${params.congress}`;
    return this.fetchList(path, 'reports', params);
  }

  async getCommitteeReport(params: GetCommitteeReportParams): Promise<{ report: unknown }> {
    const data = await this.get(
      `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}`,
    );
    const reports = data.committeeReports;
    return { report: Array.isArray(reports) ? reports[0] : reports ?? data };
  }

  async getCommitteeReportText(params: GetCommitteeReportParams): Promise<{ text: unknown }> {
    const data = await this.get(
      `/committee-report/${params.congress}/${params.reportType}/${params.reportNumber}/text`,
    );
    return { text: data.text ?? data['text-versions'] ?? data };
  }

  // --- Daily Congressional Record ---

  listDailyRecord(params?: ListDailyRecordParams): Promise<FetchListResult> {
    return this.fetchList('/daily-congressional-record', 'dailyCongressionalRecord', params);
  }

  async getDailyIssues(params: GetDailyIssuesParams): Promise<{ issues: unknown[] }> {
    const data = await this.get(`/daily-congressional-record/${params.volumeNumber}`);
    return { issues: data.dailyCongressionalRecord ?? data.issues ?? [] };
  }

  getDailyArticles(params: GetDailyArticlesParams): Promise<FetchListResult> {
    const path = `/daily-congressional-record/${params.volumeNumber}/${params.issueNumber}/articles`;
    return this.fetchList(path, 'articles', params);
  }

  // --- Congress metadata ---

  async getCurrentCongress(): Promise<CongressDetail> {
    const data = await this.get('/congress/current');
    return data.congress;
  }

  async getCongress(congress: number): Promise<CongressDetail> {
    const data = await this.get(`/congress/${congress}`);
    return data.congress;
  }

  // --- Internal ---

  private async fetchList(
    path: string,
    listKey: string,
    params?: PaginationParams & Partial<DateRangeParams>,
    extraQuery?: Record<string, string>,
  ): Promise<FetchListResult> {
    const query: Record<string, string> = { ...extraQuery };
    if (params?.limit) query.limit = String(params.limit);
    if (params?.offset) query.offset = String(params.offset);
    if (params?.fromDateTime) query.fromDateTime = params.fromDateTime;
    if (params?.toDateTime) query.toDateTime = params.toDateTime;

    const data = await this.get(path, query);
    const raw = data[listKey];
    // Some endpoints (e.g. committee-bills) nest the array inside an object — unwrap it.
    const items: unknown[] = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? (Object.values(raw).find(Array.isArray) as unknown[]) ?? []
        : [];
    const pagination = this.extractPagination(data.pagination, items.length, params);
    return { [listKey]: items, data: items, pagination };
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
  private async get(path: string, query?: Record<string, string>): Promise<any> {
    this.checkRateLimit();

    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('api_key', this.apiKey);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    if (res.status === 429) {
      throw rateLimited(
        'Congress.gov API rate limit reached (5,000 requests/hour). Wait before retrying — the limit resets hourly.',
      );
    }

    if (res.status >= 500) {
      throw serviceUnavailable(
        `Congress.gov API returned HTTP ${res.status}. The service may be temporarily unavailable — retry after a brief wait.`,
        { status: res.status },
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Congress.gov API returned HTTP ${res.status}: ${body || res.statusText}`);
    }

    this.requestCount++;
    return res.json();
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

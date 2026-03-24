/**
 * @fileoverview Types for Congress.gov API v3 responses.
 * @module services/congress-api/types
 */

/** Shared pagination metadata returned by list endpoints. */
export interface Pagination {
  count: number;
  nextOffset: number | null;
}

/** Standard pagination query params. */
export interface PaginationParams {
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Date range filter params. */
export interface DateRangeParams {
  fromDateTime?: string | undefined;
  toDateTime?: string | undefined;
}

// --- Bills ---

export type BillType = 'hr' | 's' | 'hjres' | 'sjres' | 'hconres' | 'sconres' | 'hres' | 'sres';

export type BillSubResource =
  | 'actions'
  | 'amendments'
  | 'cosponsors'
  | 'committees'
  | 'subjects'
  | 'summaries'
  | 'text'
  | 'titles'
  | 'relatedbills';

export interface ListBillsParams extends PaginationParams, DateRangeParams {
  billType?: BillType | undefined;
  congress: number;
}

export interface GetBillParams {
  billNumber: number;
  billType: BillType;
  congress: number;
}

export interface BillSubResourceParams extends GetBillParams, PaginationParams {
  subResource: BillSubResource;
}

// --- Laws ---

export type LawType = 'pub' | 'priv';

export interface ListLawsParams extends PaginationParams {
  congress: number;
  lawType?: LawType | undefined;
}

export interface GetLawParams {
  congress: number;
  lawNumber: number;
  lawType: LawType;
}

// --- Members ---

export interface ListMembersParams extends PaginationParams {
  congress?: number | undefined;
  currentMember?: boolean | undefined;
  district?: number | undefined;
  stateCode?: string | undefined;
}

export interface GetMemberLegislationParams extends PaginationParams {
  bioguideId: string;
  type: 'sponsored-legislation' | 'cosponsored-legislation';
}

// --- Committees ---

export type Chamber = 'house' | 'senate' | 'joint';

export type CommitteeSubResource = 'bills' | 'reports' | 'nominations';

export interface ListCommitteesParams extends PaginationParams {
  chamber?: Chamber | undefined;
  congress?: number | undefined;
}

export interface CommitteeSubResourceParams extends PaginationParams {
  chamber: Chamber;
  committeeCode: string;
  subResource: CommitteeSubResource;
}

// --- Votes ---

export interface ListVotesParams extends PaginationParams {
  congress: number;
  session: number;
}

export interface GetVoteParams {
  congress: number;
  session: number;
  voteNumber: number;
}

// --- Nominations ---

export type NominationSubResource = 'actions' | 'committees' | 'hearings';

export interface ListNominationsParams extends PaginationParams {
  congress: number;
}

export interface NominationSubResourceParams extends PaginationParams {
  congress: number;
  nominationNumber: string;
  subResource: NominationSubResource;
}

// --- Summaries ---

export interface ListSummariesParams extends PaginationParams, DateRangeParams {
  billType?: BillType | undefined;
  congress?: number | undefined;
}

// --- CRS Reports ---

export interface GetCrsReportParams {
  reportNumber: string;
}

// --- Committee Reports ---

export type CommitteeReportType = 'hrpt' | 'srpt' | 'erpt';

export interface ListCommitteeReportsParams extends PaginationParams {
  congress: number;
  reportType?: CommitteeReportType | undefined;
}

export interface GetCommitteeReportParams {
  congress: number;
  reportNumber: number;
  reportType: CommitteeReportType;
}

// --- Daily Congressional Record ---

export interface ListDailyRecordParams extends PaginationParams {}

export interface GetDailyIssuesParams extends PaginationParams {
  volumeNumber: number;
}

export interface GetDailyArticlesParams extends PaginationParams {
  issueNumber: number;
  volumeNumber: number;
}

// --- Congress metadata ---

export interface CongressDetail {
  congress: number;
  endYear: number;
  name: string;
  sessions: Array<{
    number: number;
    chamber: string;
    type: string;
    startDate: string;
    endDate?: string | undefined;
  }>;
  startYear: number;
}

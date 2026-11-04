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

export const BILL_TYPE_CODES = [
  'hr',
  's',
  'hjres',
  'sjres',
  'hconres',
  'sconres',
  'hres',
  'sres',
] as const;
export type BillType = (typeof BILL_TYPE_CODES)[number];

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
  sort?: 'updateDate desc' | 'updateDate asc' | undefined;
}

export interface GetBillParams {
  billNumber: number;
  billType: BillType;
  congress: number;
}

export interface BillSubResourceParams extends GetBillParams, PaginationParams {
  subResource: BillSubResource;
}

// --- Amendments ---

/**
 * Amendment types as the API path takes them — lower case, since
 * `/amendment/118/HAMDT/255` is a 404. `suamdt` (Senate unprinted) exists only
 * in the 97th and 98th Congresses.
 */
export const AMENDMENT_TYPE_CODES = ['hamdt', 'samdt', 'suamdt'] as const;
export type AmendmentType = (typeof AMENDMENT_TYPE_CODES)[number];

export type AmendmentSubResource = 'actions' | 'amendments' | 'cosponsors' | 'text';

export interface ListAmendmentsParams extends PaginationParams, DateRangeParams {
  amendmentType?: AmendmentType | undefined;
  congress: number;
  sort?: ListBillsParams['sort'];
}

export interface GetAmendmentParams {
  amendmentNumber: number;
  amendmentType: AmendmentType;
  congress: number;
}

export interface AmendmentSubResourceParams extends GetAmendmentParams, PaginationParams {
  subResource: AmendmentSubResource;
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
  /** Client-side name filter — matched in the tool layer, not sent upstream. */
  filter?: string | undefined;
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

export interface ListNominationsParams extends PaginationParams, DateRangeParams {
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

export interface ListCrsReportsParams extends PaginationParams, DateRangeParams {}

export interface GetCrsReportParams {
  reportNumber: string;
}

// --- Committee Reports ---

export type CommitteeReportType = 'hrpt' | 'srpt' | 'erpt';

export interface ListCommitteeReportsParams extends PaginationParams, DateRangeParams {
  /** Conference reports only (`true`) or none of them (`false`); unset lists both. */
  conference?: boolean | undefined;
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
  endYear: string;
  name: string;
  number: number;
  sessions: Array<{
    number: number;
    chamber: string;
    type: string;
    startDate: string;
    endDate?: string | undefined;
  }>;
  startYear: string;
  updateDate?: string;
  url?: string;
}

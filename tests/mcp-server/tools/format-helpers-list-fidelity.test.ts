/**
 * @fileoverview Output-fidelity coverage for the hand-built list-row renderers in
 * `format-helpers`: a row reaching `content[]` carries every field the upstream
 * record carries, so a `content[]`-only client sees what a `structuredContent`
 * client sees. The detail-view half of this invariant is covered by
 * `format-helpers-fidelity.test.ts`.
 *
 * Resolves cyanheads/congressgov-mcp-server#55.
 *
 * @module tests/mcp-server/tools/format-helpers-list-fidelity.test
 */

import { describe, expect, it } from 'vitest';

import {
  formatBills,
  formatCommitteeReports,
  formatCommittees,
  formatCrsReports,
  formatDailyRecord,
  formatMembers,
  formatNominations,
  formatSearchBills,
  formatSummaries,
  formatVotes,
} from '@/mcp-server/tools/format-helpers.js';

/** Extract the single text block from a formatter result. */
function textOf(blocks: Array<{ type: 'text'; text: string }>): string {
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe('text');
  return blocks[0]!.text;
}

/** Wrap rows in the paginated envelope every list formatter expects. */
function page(rows: Record<string, unknown>[], nextOffset: number | null = null) {
  return { data: rows, pagination: { count: rows.length, nextOffset } };
}

// ── Fixtures mirroring live Congress.gov / LIS list rows ────────────

/** `/committee/house` row for a subcommittee — carries the owning full committee. */
const SUBCOMMITTEE_ROW = {
  name: 'Task Force on the Declassification of Federal Secrets Subcommittee',
  systemCode: 'hzgo34',
  chamber: 'House',
  committeeTypeCode: 'Task Force',
  updateDate: '2026-01-22T19:34:38Z',
  url: 'https://api.congress.gov/v3/committee/house/hzgo34?format=json',
  parent: {
    name: 'Oversight and Government Reform Committee',
    systemCode: 'hsgo00',
    url: 'https://api.congress.gov/v3/committee/house/hsgo00?format=json',
  },
};

/** `/crsreport` row — `publishDate` and `updateDate` are distinct upstream facts. */
const CRS_ROW = {
  id: 'R46991',
  title: 'Economic Development Administration: An Overview of Programs',
  updateDate: '2026-04-10',
  publishDate: '2026-04-09',
  contentType: 'text/html',
  status: 'Active',
  version: 44,
  url: 'https://api.congress.gov/v3/crsreport/R46991?format=json',
};

/** `/summaries` row — the summary's own `updateDate` differs from `lastSummaryUpdateDate`. */
const SUMMARY_ROW = {
  actionDate: '2025-07-25',
  actionDesc: 'Introduced in House',
  versionCode: '00',
  updateDate: '2026-04-17T21:35:13Z',
  lastSummaryUpdateDate: '2026-04-17T21:34:30Z',
  text: '<p>This bill would authorize new funds.</p>',
  bill: {
    congress: 119,
    type: 'HR',
    number: '4765',
    title: 'Sample Act of 2025',
    url: 'https://api.congress.gov/v3/bill/119/hr/4765?format=json',
    updateDateIncludingText: '2026-04-18T01:00:00Z',
  },
};

/** `/committee-report` row — `cmteRptId` is the upstream primary key. */
const COMMITTEE_REPORT_ROW = {
  chamber: 'House',
  citation: 'H. Rept. 117-100',
  congress: 117,
  number: 100,
  type: 'HRPT',
  updateDate: '2025-05-27T14:15:46Z',
  url: 'https://api.congress.gov/v3/committee-report/117/HRPT/100?format=json',
  cmteRptId: 47829,
};

/** `/daily-congressional-record` row — `issueDate` carries a time component. */
const DAILY_RECORD_ROW = {
  congress: 119,
  issueDate: '2026-04-17T04:00:00Z',
  issueNumber: '68',
  sessionNumber: 2,
  updateDate: '2026-04-18T08:15:00Z',
  url: 'https://api.congress.gov/v3/daily-congressional-record/172/68?format=json',
  volumeNumber: 172,
};

// ── Characterization: curated row headers held across the fix ────────

describe('characterization — curated list-row headers', () => {
  it('keeps the committee list heading and metadata line', () => {
    const text = textOf(formatCommittees(page([SUBCOMMITTEE_ROW])));
    expect(text).toContain(
      '### 1. Task Force on the Declassification of Federal Secrets Subcommittee',
    );
    expect(text).toContain('**Code:** hzgo34 | **Chamber:** House | **Type:** Task Force');
    expect(text).toContain(
      '**URL:** https://api.congress.gov/v3/committee/house/hzgo34?format=json',
    );
  });

  it('keeps the CRS report heading and metadata line', () => {
    const text = textOf(formatCrsReports(page([CRS_ROW])));
    expect(text).toContain('### 1. R46991: Economic Development Administration');
    expect(text).toContain('**Updated:** 2026-04-10');
    expect(text).toContain('**Type:** text/html');
    expect(text).toContain('**Status:** Active');
    expect(text).toContain('**Version:** 44');
  });

  it('keeps the summary heading, metadata, bill title, and summary body', () => {
    const text = textOf(formatSummaries(page([SUMMARY_ROW])));
    expect(text).toContain('### 1. HR 4765, Congress 119');
    expect(text).toContain('**Version:** Introduced in House');
    expect(text).toContain('**Action Date:** 2025-07-25');
    expect(text).toContain('**Summary Updated:** 2026-04-17T21:34:30Z');
    expect(text).toContain('**Bill Title:** Sample Act of 2025');
    expect(text).toContain('This bill would authorize new funds.');
  });

  it('keeps the committee report citation heading', () => {
    const text = textOf(formatCommitteeReports(page([COMMITTEE_REPORT_ROW])));
    expect(text).toContain('### 1. H. Rept. 117-100');
    expect(text).toContain('**Congress:** 117 | **Chamber:** House | **Type:** HRPT');
  });

  it('keeps the daily record volume/issue heading with the date-only label', () => {
    const text = textOf(formatDailyRecord(page([DAILY_RECORD_ROW])));
    expect(text).toContain('### 1. Volume 172, Issue 68 — 2026-04-17');
    expect(text).toContain('**Congress:** 119 | **Session:** 2');
  });
});

// ── #55 — the five renderers the issue names ────────────────────────

describe('#55 — committee list rows keep the parent committee', () => {
  it('renders the parent committee code a caller needs to chain upward', () => {
    const text = textOf(formatCommittees(page([SUBCOMMITTEE_ROW])));
    expect(text).toContain('hsgo00');
    expect(text).toContain('Oversight and Government Reform Committee');
  });

  it('adds nothing when a full committee row carries no parent', () => {
    const text = textOf(
      formatCommittees(page([{ name: 'Judiciary Committee', systemCode: 'hsju00' }])),
    );
    expect(text).toContain('### 1. Judiciary Committee');
    expect(text).not.toContain('parent');
  });
});

describe('#55 — CRS report rows keep the publish date', () => {
  it('renders publishDate alongside the updateDate the header shows', () => {
    const text = textOf(formatCrsReports(page([CRS_ROW])));
    expect(text).toContain('**Updated:** 2026-04-10');
    expect(text).toContain('2026-04-09');
  });

  it('does not repeat the publish date when it is the only date present', () => {
    const text = textOf(formatCrsReports(page([{ id: 'IF12345', publishDate: '2025-12-01' }])));
    expect(text).toContain('**Updated:** 2025-12-01');
    expect(text.match(/2025-12-01/g)).toHaveLength(1);
  });
});

describe('#55 — bill summary rows keep the version code and update dates', () => {
  const text = textOf(formatSummaries(page([SUMMARY_ROW])));

  it('renders the versionCode the actionDesc header replaces', () => {
    expect(text).toContain('00');
    expect(text).toMatch(/versionCode/);
  });

  it("renders the summary's own updateDate alongside lastSummaryUpdateDate", () => {
    expect(text).toContain('2026-04-17T21:35:13Z');
  });

  it('renders the referenced bill fields the header never names', () => {
    expect(text).toContain('2026-04-18T01:00:00Z');
  });
});

describe('#55 — committee report rows keep the upstream report id', () => {
  it('renders cmteRptId', () => {
    const text = textOf(formatCommitteeReports(page([COMMITTEE_REPORT_ROW])));
    expect(text).toContain('47829');
  });
});

describe('#55 — daily record rows keep the full issue timestamp', () => {
  it('renders the issueDate time component the heading truncates', () => {
    const text = textOf(formatDailyRecord(page([DAILY_RECORD_ROW])));
    expect(text).toContain('2026-04-17T04:00:00Z');
  });
});

// ── #55 — drops the issue did not name ──────────────────────────────

describe('#55 — bill list rows keep every upstream field', () => {
  it('renders updateDateIncludingText, which the curated header never named', () => {
    const text = textOf(
      formatBills(
        page([
          {
            congress: 119,
            type: 'HR',
            number: '1',
            title: 'Lower Energy Costs Act',
            updateDate: '2026-01-01T00:00:00Z',
            updateDateIncludingText: '2026-01-02T00:00:00Z',
          },
        ]),
      ),
    );
    expect(text).toContain('HR 1: Lower Energy Costs Act');
    expect(text).toContain('2026-01-02T00:00:00Z');
  });

  it("renders a sponsor's bioguideId, the identifier the sponsor line drops", () => {
    const text = textOf(
      formatBills(
        page([
          {
            congress: 119,
            type: 'HR',
            number: '1',
            title: 'Sponsored Act',
            sponsors: [
              {
                bioguideId: 'P000197',
                fullName: 'Rep. Pelosi, Nancy [D-CA-11]',
                party: 'D',
                state: 'CA',
                url: 'https://api.congress.gov/v3/member/P000197?format=json',
              },
            ],
          },
        ]),
      ),
    );
    expect(text).toContain('**Sponsor:** Rep. Pelosi, Nancy [D-CA-11] (D-CA)');
    expect(text).toContain('P000197');
  });
});

describe('#55 — member list rows keep every upstream field', () => {
  const text = textOf(
    formatMembers(
      page([
        {
          bioguideId: 'S000148',
          name: 'Schumer, Charles E.',
          partyName: 'Democratic',
          state: 'New York',
          updateDate: '2026-02-01T00:00:00Z',
          depiction: {
            imageUrl: 'https://www.congress.gov/img/member/s000148_200.jpg',
            attribution: 'Courtesy U.S. Senate Historical Office',
          },
          terms: {
            item: [
              {
                chamber: 'House of Representatives',
                congress: 96,
                district: 9,
                startYear: 1979,
                endYear: 1981,
                memberType: 'Representative',
                stateCode: 'NY',
              },
            ],
          },
          url: 'https://api.congress.gov/v3/member/S000148?format=json',
        },
      ]),
    ),
  );

  it('keeps the curated identity line', () => {
    expect(text).toContain('### 1. Schumer, Charles E.');
    expect(text).toContain('**ID:** S000148 | **Party:** Democratic | **State:** New York');
  });

  it('renders the portrait depiction and the record update date', () => {
    expect(text).toContain('https://www.congress.gov/img/member/s000148_200.jpg');
    expect(text).toContain('2026-02-01T00:00:00Z');
  });

  it('renders term fields nested two levels below the row', () => {
    expect(text).toContain('district: 9');
    expect(text).toContain('memberType: Representative');
    expect(text).toContain('stateCode: NY');
  });
});

describe('#55 — bill action rows keep committees and recorded votes', () => {
  const text = textOf(
    formatBills(
      page([
        {
          actionCode: 'H11000',
          actionDate: '2023-06-23',
          committees: [
            {
              name: 'Agriculture Committee',
              systemCode: 'hsag00',
              url: 'https://api.congress.gov/v3/committee/house/hsag00?format=json',
            },
          ],
          sourceSystem: { code: 1, name: 'House committee actions' },
          text: 'Referred to the Subcommittee on Conservation.',
          type: 'Committee',
          recordedVotes: [
            {
              chamber: 'House',
              congress: 118,
              date: '2023-06-23T18:00:00Z',
              rollNumber: 120,
              sessionNumber: 1,
              url: 'https://clerk.house.gov/evs/2023/roll120.xml',
            },
          ],
        },
      ]),
    ),
  );

  it('keeps the curated action heading and committee name line', () => {
    expect(text).toContain('### 1. 2023-06-23 — Referred to the Subcommittee on Conservation.');
    expect(text).toContain('**Committees:** Agriculture Committee');
  });

  it("renders the committee's systemCode, the identifier the name line drops", () => {
    expect(text).toContain('hsag00');
  });

  it('renders the recorded vote the curated action row never named', () => {
    expect(text).toContain('rollNumber: 120');
    expect(text).toContain('https://clerk.house.gov/evs/2023/roll120.xml');
  });
});

describe('#55 — roll call vote rows keep every upstream field', () => {
  it('renders the vote question the list row never named', () => {
    const text = textOf(
      formatVotes(
        page([
          {
            congress: 119,
            rollCallNumber: 240,
            result: 'Passed',
            voteType: '2/3 Yea-And-Nay',
            voteQuestion: 'On Motion to Suspend the Rules and Pass',
          },
        ]),
      ),
    );
    expect(text).toContain('### 1. Roll 240 — Passed');
    expect(text).toContain('On Motion to Suspend the Rules and Pass');
  });
});

describe('#55 — member voting positions keep the member identifier', () => {
  it('renders a House position with its bioguideId', () => {
    const text = textOf(
      formatVotes({
        data: [
          {
            bioguideId: 'D000626',
            firstName: 'Warren',
            lastName: 'Davidson',
            voteCast: 'Nay',
            voteParty: 'R',
            voteState: 'OH',
          },
        ],
        pagination: { count: 1, nextOffset: null },
        vote: { rollCallNumber: 99, congress: 118, sessionNumber: 1, result: 'Failed' },
      }),
    );
    expect(text).toContain('- Warren Davidson (R-OH) → Nay');
    expect(text).toContain('D000626');
  });

  it('renders a Senate position with its LIS member id', () => {
    const text = textOf(
      formatVotes({
        chamber: 'senate',
        data: [
          {
            chamber: 'senate',
            memberFull: 'Baldwin (D-WI)',
            firstName: 'Tammy',
            lastName: 'Baldwin',
            party: 'D',
            state: 'WI',
            voteCast: 'Yea',
            lisMemberId: 'S354',
          },
        ],
        pagination: { count: 1, nextOffset: null },
        vote: { chamber: 'senate', voteNumber: 1, congress: 118, session: 2 },
      }),
    );
    expect(text).toContain('- Baldwin (D-WI) → Yea');
    expect(text).toContain('S354');
    expect(text).toContain('Tammy');
  });

  it('renders the vote-context fields the members header never named', () => {
    const text = textOf(
      formatVotes({
        data: [{ bioguideId: 'B001297', lastName: 'Buck', voteCast: 'Nay' }],
        pagination: { count: 1, nextOffset: null },
        vote: {
          rollCallNumber: 99,
          congress: 118,
          sessionNumber: 1,
          result: 'Failed',
          startDate: '2023-02-01T14:00:00Z',
          sourceDataURL: 'https://clerk.house.gov/Votes/202399.xml',
        },
      }),
    );
    expect(text).toContain('# Roll 99 — 118th Congress, session 1');
    expect(text).toContain('2023-02-01T14:00:00Z');
    expect(text).toContain('https://clerk.house.gov/Votes/202399.xml');
  });
});

describe('#55 — nomination rows keep every upstream field', () => {
  it('renders the nomination organization and calendar number', () => {
    const text = textOf(
      formatNominations(
        page([
          {
            citation: 'PN851-1',
            congress: 119,
            nominationType: { isCivilian: true },
            organization: 'Department of Justice',
            executiveCalendarNumber: '412',
          },
        ]),
      ),
    );
    expect(text).toContain('### 1. PN851-1');
    expect(text).toContain('**Type:** Civilian');
    expect(text).toContain('Department of Justice');
    expect(text).toContain('412');
  });

  it('renders the position a nominee row is nominated to', () => {
    const text = textOf(
      formatNominations(
        page([
          {
            firstName: 'Sheria',
            lastName: 'Clarke',
            ordinal: 1,
            state: 'SC',
            positionTitle: 'General Counsel of the Federal Labor Relations Authority',
            organization: 'Federal Labor Relations Authority',
          },
        ]),
      ),
    );
    expect(text).toContain('### 1. Sheria Clarke');
    expect(text).toContain('General Counsel of the Federal Labor Relations Authority');
  });

  it('renders the congress a hearing row belongs to', () => {
    const text = textOf(
      formatNominations(
        page([
          {
            chamber: 'Senate',
            citation: 'S.Hrg. 119-42',
            congress: 119,
            date: '2026-03-25',
            jacketNumber: 12345,
            number: 42,
            partNumber: '1',
          },
        ]),
      ),
    );
    expect(text).toContain('### 1. S.Hrg. 119-42');
    expect(text).toContain('**Date:** 2026-03-25');
    expect(text).toContain('119');
  });

  it('renders the activity timestamp a committee row truncates', () => {
    const text = textOf(
      formatNominations(
        page([
          {
            activities: [{ date: '2026-04-30T19:28:22Z', name: 'Reported By' }],
            chamber: 'Senate',
            name: 'Judiciary Committee',
            systemCode: 'ssju00',
            type: 'Standing',
          },
        ]),
      ),
    );
    expect(text).toContain('2026-04-30 — Reported By');
    expect(text).toContain('2026-04-30T19:28:22Z');
  });
});

describe('#55 — amendment rows keep every upstream field', () => {
  it('renders the amendment update date and purpose', () => {
    const text = textOf(
      formatMembers(
        page([
          {
            amendmentNumber: '3331',
            congress: 119,
            introducedDate: '2025-01-01',
            purpose: 'To delay the repeal of the Government pension offset.',
            updateDate: '2026-01-01T00:00:00Z',
            url: 'https://api.congress.gov/v3/amendment/119/samdt/3331?format=json',
          },
        ]),
      ),
    );
    expect(text).toContain('### 1. Senate Amendment 3331');
    expect(text).toContain('To delay the repeal of the Government pension offset.');
    expect(text).toContain('2026-01-01T00:00:00Z');
  });
});

// ── The invariant itself, across every hand-built list renderer ──────

/** A field no curated header names — the sentinel each renderer must fall through. */
const SENTINEL = 'sentinel-unmapped-value';

const listRenderers: Array<{
  name: string;
  render: (result: Record<string, unknown>) => Array<{ type: 'text'; text: string }>;
  row: Record<string, unknown>;
}> = [
  { name: 'bill list', render: formatBills, row: { type: 'HR', number: '1', title: 'Act' } },
  {
    name: 'bill action',
    render: formatBills,
    row: { actionDate: '2026-01-01', text: 'Referred.', actionCode: 'H1' },
  },
  {
    name: 'bill text version',
    render: formatBills,
    row: { type: 'Enrolled Bill', formats: [{ type: 'PDF', url: 'https://example.gov/b.pdf' }] },
  },
  {
    name: 'bill sub-resource summary',
    render: formatBills,
    row: { actionDesc: 'Introduced in House', text: '<p>Body.</p>' },
  },
  {
    name: 'member list',
    render: formatMembers,
    row: { bioguideId: 'S000148', name: 'Schumer, Charles E.' },
  },
  {
    name: 'member amendment',
    render: formatMembers,
    row: { amendmentNumber: '3331', congress: 119 },
  },
  {
    name: 'bill summary',
    render: formatSummaries,
    row: { actionDate: '2026-01-01', bill: { congress: 119, type: 'HR', number: '1' } },
  },
  { name: 'CRS report', render: formatCrsReports, row: { id: 'R46991', title: 'Overview' } },
  {
    name: 'daily record issue',
    render: formatDailyRecord,
    row: { volumeNumber: 172, issueNumber: '68' },
  },
  {
    name: 'daily record article',
    render: formatDailyRecord,
    row: { sectionName: 'Daily Digest', title: 'Next Meeting', startPage: 'D407' },
  },
  {
    name: 'House roll call vote',
    render: formatVotes,
    row: { rollCallNumber: 240, result: 'Passed' },
  },
  {
    name: 'Senate roll call vote',
    render: formatVotes,
    row: { chamber: 'senate', voteNumber: 339, issue: 'H.R. 10545', yeas: 85, nays: 11 },
  },
  {
    name: 'committee list',
    render: formatCommittees,
    row: { name: 'Judiciary Committee', systemCode: 'hsju00' },
  },
  {
    name: 'committee report list',
    render: formatCommitteeReports,
    row: { citation: 'H. Rept. 117-100', congress: 117, type: 'HRPT', number: 100 },
  },
  {
    name: 'nomination list',
    render: formatNominations,
    row: { citation: 'PN851-1', congress: 119 },
  },
  {
    name: 'nomination committee',
    render: formatNominations,
    row: { name: 'Judiciary Committee', systemCode: 'ssju00', chamber: 'Senate' },
  },
  { name: 'nominee', render: formatNominations, row: { firstName: 'Sheria', lastName: 'Clarke' } },
  {
    name: 'nomination hearing',
    render: formatNominations,
    row: { jacketNumber: 12345, number: 42, chamber: 'Senate' },
  },
  {
    name: 'bill search hit',
    render: formatSearchBills,
    row: { billId: '119/hr/1', billType: 'hr', billNumber: 1, congress: 119, title: 'Act' },
  },
];

describe('#55 — every hand-built list renderer falls through to unnamed fields', () => {
  for (const { name, render, row } of listRenderers) {
    it(`${name} rows render a field no curated line names`, () => {
      const text = textOf(render(page([{ ...row, unmappedUpstreamField: SENTINEL }])));
      expect(text).toContain(SENTINEL);
    });
  }

  it('committee report text rows render a field no curated line names', () => {
    const text = textOf(
      formatCommitteeReports({
        text: [
          {
            formats: [{ isErrata: 'N', type: 'PDF', url: 'https://example.gov/r.pdf' }],
            unmappedUpstreamField: SENTINEL,
          },
        ],
      }),
    );
    expect(text).toContain(SENTINEL);
  });
});

describe('#55 — the generic list renderer keeps identifiers its heading never used', () => {
  /**
   * `committee_lookup reports` rows carry both a `citation` and a `type`/`number`
   * pair. The heading is built from `type` + `number`, so the citation — the
   * label Congress.gov itself publishes — is the one a reader needs and the one a
   * fixed skip-list silently swallows.
   */
  const REPORT_ROW = {
    chamber: 'House',
    citation: 'H. Rept. 113-118',
    congress: 113,
    number: 118,
    part: 1,
    type: 'HRPT',
    updateDate: '2019-02-17T12:04:52Z',
    url: 'https://api.congress.gov/v3/committee-report/113/HRPT/118?format=json',
  };

  it('renders the citation when the heading came from type and number', () => {
    const text = textOf(formatCommittees(page([REPORT_ROW])));
    expect(text).toContain('### 1. HRPT 118');
    expect(text).toContain('H. Rept. 113-118');
  });

  it('does not repeat an identifier the heading did use', () => {
    const { type: _type, number: _number, ...citationOnly } = REPORT_ROW;
    const text = textOf(formatCommittees(page([citationOnly])));
    expect(text).toContain('### 1. H. Rept. 113-118');
    expect(text.match(/H\. Rept\. 113-118/g)).toHaveLength(1);
  });

  it('keeps every sub-field of a latest-action object', () => {
    const text = textOf(
      formatCommittees(
        page([
          {
            title: 'A bill with a timestamped action',
            number: 4765,
            latestAction: {
              actionDate: '2026-03-04',
              actionTime: '12:08:46',
              text: 'Referred to the Committee on Oversight.',
            },
          },
        ]),
      ),
    );
    expect(text).toContain('2026-03-04');
    expect(text).toContain('12:08:46');
    expect(text).toContain('Referred to the Committee on Oversight.');
  });
});

// ── Boundaries ──────────────────────────────────────────────────────

describe('#55 — boundaries hold for the touched list renderers', () => {
  const empty = { data: [], pagination: { count: 0, nextOffset: null } };
  const pastEnd = { data: [], pagination: { count: 42, nextOffset: null } };

  const formatters: Array<
    [string, (r: Record<string, unknown>) => Array<{ type: 'text'; text: string }>]
  > = [
    ['committees', formatCommittees],
    ['CRS reports', formatCrsReports],
    ['summaries', formatSummaries],
    ['committee reports', formatCommitteeReports],
    ['daily record', formatDailyRecord],
    ['votes', formatVotes],
    ['nominations', formatNominations],
    ['bill search', formatSearchBills],
  ];

  for (const [name, format] of formatters) {
    it(`${name} reports zero matches on an empty result`, () => {
      const text = textOf(format(empty));
      expect(text).toContain('**0 results**');
      expect(text).toContain('No matching results');
    });

    it(`${name} distinguishes an offset past the end from zero matches`, () => {
      const text = textOf(format(pastEnd));
      expect(text).toContain('Page is empty');
      expect(text).toContain('past the end of 42 total items');
    });
  }

  it('renders a row whose every field is null or empty without inventing values', () => {
    const text = textOf(
      formatCommittees(page([{ name: 'Bare Committee', systemCode: null, parent: null, url: '' }])),
    );
    expect(text).toContain('### 1. Bare Committee');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('renders a full page at the row cap with a continuation offset', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      name: `Committee ${i + 1}`,
      systemCode: `hs${String(i).padStart(4, '0')}`,
      parent: { name: 'Parent Committee', systemCode: 'hsgo00' },
    }));
    const text = textOf(
      formatCommittees({ data: rows, pagination: { count: 900, nextOffset: 250 } }),
    );
    expect(text).toContain('**900 results** | next offset: 250');
    expect(text).toContain('### 250. Committee 250');
    expect(text.match(/hsgo00/g)).toHaveLength(250);
  });
});

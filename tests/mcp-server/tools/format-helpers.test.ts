/**
 * @fileoverview Tests for format-helpers — regression coverage for the
 * field-test audit in GitHub issue #2. Every fixture mirrors a real
 * Congress.gov API v3 response shape captured during validation.
 * @module tests/mcp-server/tools/format-helpers.test
 */

import { describe, expect, it } from 'vitest';

import {
  formatBills,
  formatCommitteeReports,
  formatCommittees,
  formatCrsReports,
  formatDailyRecord,
  formatLaws,
  formatMembers,
  formatNominations,
  formatSummaries,
  formatVotes,
} from '@/mcp-server/tools/format-helpers.js';

/** Extract the single text block from a formatter result. */
function textOf(blocks: Array<{ type: 'text'; text: string }>): string {
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe('text');
  return blocks[0]!.text;
}

describe('formatCrsReports (issue #1)', () => {
  it('uses the `id` field for the heading when reportNumber is missing', () => {
    // Real payload: Congress.gov returns CRS report IDs only under `id`.
    const text = textOf(
      formatCrsReports({
        data: [
          {
            id: 'R46991',
            title: 'Economic Development Administration: An Overview of Programs',
            updateDate: '2026-04-10',
            publishDate: '2026-04-09',
            contentType: 'text/html',
            status: 'Active',
            url: 'https://api.congress.gov/v3/crsreport/R46991?format=json',
            version: 44,
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('R46991');
    expect(text).toContain('Economic Development Administration: An Overview of Programs');
    expect(text).toContain('**Updated:** 2026-04-10');
    expect(text).not.toContain('Report number not available');
  });

  it('falls back to publishDate when updateDate is absent', () => {
    const text = textOf(
      formatCrsReports({
        data: [
          {
            id: 'IF12345',
            title: 'Short Form',
            publishDate: '2025-12-01',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Updated:** 2025-12-01');
  });

  it('still prefers reportNumber when present for backward compatibility', () => {
    const text = textOf(
      formatCrsReports({
        data: [
          {
            reportNumber: 'RL33612',
            id: 'should-be-ignored',
            title: 'Legacy Report',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('RL33612');
    expect(text).not.toContain('should-be-ignored');
  });

  it('reports missing fields honestly when the item is sparse', () => {
    const text = textOf(
      formatCrsReports({
        data: [{}],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Report number not available');
    expect(text).toContain('Title not available');
    expect(text).toContain('Summary not available');
  });
});

describe('formatSummaries (issue #2)', () => {
  it('surfaces both actionDate and lastSummaryUpdateDate in the heading metadata', () => {
    // Real payload: /summaries filter applies to lastSummaryUpdateDate, not actionDate.
    const text = textOf(
      formatSummaries({
        data: [
          {
            actionDate: '2025-07-25',
            actionDesc: 'Introduced in House',
            updateDate: '2026-04-17T21:35:13Z',
            lastSummaryUpdateDate: '2026-04-17T21:34:30Z',
            text: '<p>This bill would authorize&amp;grant new funds.</p>',
            bill: {
              congress: 119,
              type: 'HR',
              number: '4765',
              title: 'Sample Act of 2025',
              url: 'https://api.congress.gov/v3/bill/119/hr/4765?format=json',
            },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('HR 4765');
    expect(text).toContain('**Action Date:** 2025-07-25');
    expect(text).toContain('**Summary Updated:** 2026-04-17T21:34:30Z');
    expect(text).toContain('**Version:** Introduced in House');
    expect(text).toContain('Sample Act of 2025');
    // stripHtml should strip tags and decode standard entities
    expect(text).toContain('This bill would authorize&grant new funds.');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('&amp;');
  });

  it('falls back to updateDate when lastSummaryUpdateDate is missing', () => {
    const text = textOf(
      formatSummaries({
        data: [
          {
            actionDate: '2024-05-01',
            updateDate: '2026-04-17T20:00:00Z',
            bill: { congress: 118, type: 'S', number: '1' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Summary Updated:** 2026-04-17T20:00:00Z');
  });
});

describe('formatDailyRecord (issue #3)', () => {
  it('renders volume, issue, and issue date instead of "Item"', () => {
    // Real payload from /daily-congressional-record
    const text = textOf(
      formatDailyRecord({
        data: [
          {
            congress: 119,
            issueDate: '2026-04-17T04:00:00Z',
            issueNumber: '68',
            sessionNumber: 2,
            updateDate: '2026-04-18T08:15:00Z',
            url: 'https://api.congress.gov/v3/daily-congressional-record/172/68?format=json',
            volumeNumber: 172,
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Volume 172, Issue 68 — 2026-04-17');
    expect(text).toContain('**Congress:** 119');
    expect(text).toContain('**Session:** 2');
    expect(text).not.toMatch(/###\s*1\.\s*Item/);
  });

  it('still renders a useful heading when issueDate is missing', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{ volumeNumber: 171, issueNumber: '3' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Volume 171, Issue 3');
    expect(text).not.toContain('Item');
  });

  it('gracefully handles completely empty items without crashing', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{}],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toMatch(/### 1\. Item/);
  });
});

describe('formatVotes (issue #4)', () => {
  it('renders roll call number, legislation ref, and result in the heading', () => {
    const text = textOf(
      formatVotes({
        data: [
          {
            congress: 119,
            identifier: 240,
            legislationNumber: '3424',
            legislationType: 'HR',
            legislationUrl: 'https://www.congress.gov/bill/119/hr/3424',
            result: 'Passed',
            rollCallNumber: 240,
            sessionNumber: 1,
            sourceDataURL: 'https://clerk.house.gov/Votes/...',
            startDate: '2025-09-08T18:56:00-04:00',
            updateDate: '2025-09-09T01:00:00Z',
            url: 'https://api.congress.gov/v3/house-vote/119/1/240?format=json',
            voteType: '2/3 Yea-And-Nay',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Roll 240: HR 3424 — Passed');
    expect(text).toContain('**Congress:** 119');
    expect(text).toContain('**Type:** 2/3 Yea-And-Nay');
    expect(text).toContain('**Date:** 2025-09-08T18:56:00-04:00');
    expect(text).not.toMatch(/###\s*1\.\s*Item/);
  });

  it('handles procedural votes that are not tied to legislation', () => {
    const text = textOf(
      formatVotes({
        data: [
          {
            rollCallNumber: 12,
            result: 'Agreed to',
            voteType: 'Yea-And-Nay',
            startDate: '2026-02-03T14:00:00Z',
            congress: 119,
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Roll 12 — Agreed to');
    expect(text).not.toContain(': —');
  });

  it('still routes detail operations through renderDetail', () => {
    const text = textOf(
      formatVotes({
        vote: {
          rollCallNumber: 240,
          result: 'Passed',
          question: 'On Motion to Suspend the Rules and Pass',
        },
      }),
    );
    expect(text).toContain('**rollCallNumber:** 240');
    expect(text).toContain('**question:**');
  });
});

describe('formatBills — actions sub-resource (issue #5)', () => {
  it('renders action date + text as the heading', () => {
    // Real payload from /bill/{congress}/{billType}/{billNumber}/actions
    const text = textOf(
      formatBills({
        data: [
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
            text: 'Referred to the Subcommittee on Conservation, Research, and Biotechnology.',
            type: 'Committee',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain(
      '2023-06-23 — Referred to the Subcommittee on Conservation, Research, and Biotechnology.',
    );
    expect(text).toContain('**Type:** Committee');
    expect(text).toContain('**Action Code:** H11000');
    expect(text).toContain('**Source:** House committee actions');
    expect(text).toContain('**Committees:** Agriculture Committee');
    expect(text).not.toMatch(/###\s*1\.\s*Item/);
  });

  it('falls back when actionDate is missing but actionCode is present', () => {
    const text = textOf(
      formatBills({
        data: [{ actionCode: 'H0L', text: 'Action with no date', type: 'Floor' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('### 1. Action with no date');
    expect(text).toContain('**Action Code:** H0L');
  });

  it('still uses the bill renderer when list items look like bills', () => {
    const text = textOf(
      formatBills({
        data: [
          {
            congress: 119,
            type: 'hr',
            number: '1',
            title: 'Lower Energy Costs Act',
            updateDate: '2026-04-18',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('HR 1: Lower Energy Costs Act');
    expect(text).toContain('**Congress:** 119');
  });
});

describe('formatCommitteeReports — text operation (issue #6)', () => {
  it('unwraps the formats array and surfaces document type + URL', () => {
    // Real payload from /committee-report/{congress}/{type}/{number}/text
    const text = textOf(
      formatCommitteeReports({
        text: [
          {
            formats: [
              {
                isErrata: 'N',
                type: 'PDF',
                url: 'https://www.congress.gov/117/crpt/hrpt100/CRPT-117hrpt100.pdf',
              },
            ],
          },
          {
            formats: [
              {
                isErrata: 'N',
                type: 'Formatted Text',
                url: 'https://www.congress.gov/117/crpt/hrpt100/generated/CRPT-117hrpt100.htm',
              },
            ],
          },
        ],
      }),
    );
    expect(text).toContain('### 1. PDF');
    expect(text).toContain('### 2. Formatted Text');
    expect(text).toContain(
      '**PDF:** https://www.congress.gov/117/crpt/hrpt100/CRPT-117hrpt100.pdf',
    );
    expect(text).toContain(
      '**Formatted Text:** https://www.congress.gov/117/crpt/hrpt100/generated/CRPT-117hrpt100.htm',
    );
    expect(text).not.toMatch(/###\s*1\.\s*Item/);
  });

  it('flags errata formats in the heading', () => {
    const text = textOf(
      formatCommitteeReports({
        text: [
          {
            formats: [{ isErrata: 'Y', type: 'PDF', url: 'https://example.gov/errata.pdf' }],
          },
        ],
      }),
    );
    expect(text).toContain('### 1. PDF (Errata)');
    expect(text).toContain('**PDF (Errata):**');
  });

  it('passes through list and detail shapes untouched', () => {
    const listText = textOf(
      formatCommitteeReports({
        data: [{ type: 'HRPT', number: 100, title: 'Sample Report' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(listText).toContain('### 1. HRPT 100: Sample Report');

    const detailText = textOf(
      formatCommitteeReports({
        report: { title: 'Detail Title', congress: 117 },
      }),
    );
    expect(detailText).toContain('**title:** Detail Title');
  });
});

describe('formatCommittees — detail heading (issue #7)', () => {
  it('surfaces history[0].officialName as a top-level heading', () => {
    // Real payload for /committee/senate/ssev00 — no top-level `name` field.
    const text = textOf(
      formatCommittees({
        committee: {
          systemCode: 'ssev00',
          type: 'Standing',
          history: [
            {
              officialName: 'Committee on Environment and Public Works',
              libraryOfCongressName: 'Environment and Public Works',
              startDate: '1977-02-04T05:00:00Z',
            },
          ],
          subcommittees: [
            {
              name: 'Clean Air and Nuclear Safety Subcommittee',
              systemCode: 'ssev01',
            },
          ],
        },
      }),
    );
    expect(text.startsWith('# Committee on Environment and Public Works')).toBe(true);
    expect(text).toContain('**systemCode:** ssev00');
    expect(text).toContain('Clean Air and Nuclear Safety');
  });

  it('falls back to libraryOfCongressName when officialName is absent', () => {
    const text = textOf(
      formatCommittees({
        committee: {
          systemCode: 'xxxx00',
          history: [{ libraryOfCongressName: 'Old Committee Name' }],
        },
      }),
    );
    expect(text.startsWith('# Old Committee Name')).toBe(true);
  });

  it('prefers the direct name field when present', () => {
    const text = textOf(
      formatCommittees({
        committee: {
          name: 'Judiciary Committee',
          history: [{ officialName: 'Former Name' }],
        },
      }),
    );
    expect(text.startsWith('# Judiciary Committee')).toBe(true);
    // The detail body still includes all fields — the heading just picks the best label.
    expect(text).toContain('**name:** Judiciary Committee');
  });

  it('omits the heading when no committee name is available anywhere', () => {
    const text = textOf(
      formatCommittees({
        committee: { systemCode: 'xxxx99' },
      }),
    );
    expect(text.startsWith('#')).toBe(false);
    expect(text).toContain('**systemCode:** xxxx99');
  });

  it('keeps the existing list behavior for the list operation', () => {
    const text = textOf(
      formatCommittees({
        data: [
          {
            name: 'Energy and Natural Resources Committee',
            systemCode: 'sseg00',
            chamber: 'Senate',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('### 1.');
    expect(text).toContain('Energy and Natural Resources Committee');
  });
});

describe('pagination header', () => {
  it('shows the total count and next offset when present', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{ volumeNumber: 172, issueNumber: '68', issueDate: '2026-04-17' }],
        pagination: { count: 42, nextOffset: 20 },
      }),
    );
    expect(text).toContain('**42 results**');
    expect(text).toContain('next offset: 20');
  });

  it('omits the next-offset hint when nextOffset is null', () => {
    const text = textOf(
      formatDailyRecord({
        data: [],
        pagination: { count: 0, nextOffset: null },
      }),
    );
    expect(text).toContain('**0 results**');
    expect(text).not.toContain('next offset');
  });
});

describe('shared renderers preserved (regression)', () => {
  it('renderBillItem still drives enacted laws formatting', () => {
    const text = textOf(
      formatLaws({
        data: [
          {
            congress: 118,
            type: 'HR',
            number: '1',
            title: 'Lower Energy Costs Act',
            latestAction: { actionDate: '2024-01-02', text: 'Became Public Law.' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('HR 1: Lower Energy Costs Act');
    expect(text).toContain('**Latest Action:** 2024-01-02 — Became Public Law.');
  });

  it('renderMemberItem still drives member list formatting', () => {
    const text = textOf(
      formatMembers({
        data: [
          {
            bioguideId: 'S000148',
            name: 'Schumer, Charles E.',
            party: 'D',
            state: 'NY',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Schumer, Charles E.');
    expect(text).toContain('**ID:** S000148');
    expect(text).toContain('**Party:** D');
  });

  it('formatNominations falls back to generic detail for nomination objects', () => {
    const text = textOf(
      formatNominations({
        nomination: {
          citation: 'PN123',
          description: 'Nominee description',
          congress: 119,
        },
      }),
    );
    expect(text).toContain('**citation:** PN123');
    expect(text).toContain('**description:** Nominee description');
  });
});

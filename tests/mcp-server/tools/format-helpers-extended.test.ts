/**
 * @fileoverview Additional format-helper tests: edge cases, unicode, security,
 * and gaps not covered by the main format-helpers.test.ts file.
 * @module tests/mcp-server/tools/format-helpers-extended.test
 */

import { describe, expect, it } from 'vitest';

import {
  formatAmendments,
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

/** Extract the single text block. */
function textOf(blocks: Array<{ type: 'text'; text: string }>): string {
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe('text');
  return blocks[0]!.text;
}

// ── Security: HTML/script injection through upstream fields ───────────────────

describe('security: HTML injection in upstream fields does not propagate', () => {
  it('strips script tags from bill title fields', () => {
    const text = textOf(
      formatBills({
        data: [
          {
            congress: 119,
            type: 'HR',
            number: '1',
            title: '<script>alert("xss")</script>Safe Title',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).not.toContain('<script>');
    expect(text).toContain('Safe Title');
  });

  it('strips HTML from member name fields', () => {
    const text = textOf(
      formatMembers({
        data: [
          {
            bioguideId: 'S000148',
            name: '<b>Schumer</b>, Charles E.',
            party: 'D',
            state: 'NY',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).not.toContain('<b>');
    expect(text).toContain('Schumer');
  });

  it('strips HTML from CRS report titles', () => {
    const text = textOf(
      formatCrsReports({
        data: [
          {
            id: 'R40097',
            title: '<em>Climate</em> &amp; Energy Policy',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).not.toContain('<em>');
    expect(text).toContain('Climate');
    expect(text).toContain('& Energy Policy');
  });

  it('strips HTML from nomination descriptions', () => {
    const text = textOf(
      formatNominations({
        nomination: {
          citation: 'PN100',
          description: '<script>evil()</script>Normal description',
          congress: 119,
        },
      }),
    );
    expect(text).not.toContain('<script>');
    expect(text).toContain('Normal description');
  });

  it('decodes HTML entities in summary text without leaving raw HTML', () => {
    const text = textOf(
      formatSummaries({
        data: [
          {
            actionDate: '2025-01-15',
            text: '<p>The bill &amp; its amendments.</p>',
            bill: { congress: 119, type: 'HR', number: '10' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).not.toContain('<p>');
    expect(text).toContain('The bill & its amendments.');
  });
});

// ── Unicode / encoding edge cases ─────────────────────────────────────────────

describe('unicode and encoding edge cases', () => {
  it('renders member name with non-ASCII characters correctly', () => {
    const text = textOf(
      formatMembers({
        data: [{ bioguideId: 'G000591', name: 'García, Mike', party: 'R', state: 'CA' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('García');
  });

  it('renders CRS report title with em-dash correctly', () => {
    const text = textOf(
      formatCrsReports({
        data: [{ id: 'R99001', title: 'Policy Analysis — A Review' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Policy Analysis — A Review');
  });

  it('handles bill title with curly quotes without crashing', () => {
    // Use Unicode curly/smart quote characters (U+201C and U+201D)
    const title = '“Clean” Energy Act';
    const text = textOf(
      formatBills({
        data: [{ congress: 119, type: 'HR', number: '42', title }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Energy Act');
    expect(text).toContain('HR 42');
  });

  it('handles committee name with parenthetical without crashing', () => {
    const text = textOf(
      formatCommittees({
        data: [
          {
            name: 'Select Committee on the Climate Crisis (Former)',
            systemCode: 'hscc00',
            chamber: 'House',
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Select Committee on the Climate Crisis');
  });
});

// ── Absent/sparse upstream fields ─────────────────────────────────────────────

describe('sparse upstream fields — no fabricated values', () => {
  it('formatBills handles item with no type or number without crashing', () => {
    const text = textOf(
      formatBills({
        data: [{ title: 'Unknown Bill Type', congress: 118 }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Unknown Bill Type');
  });

  it('formatMembers renders member with no party or state', () => {
    const text = textOf(
      formatMembers({
        data: [{ bioguideId: 'X000001', name: 'Anonymous Member' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Anonymous Member');
    expect(text).toContain('X000001');
  });

  it('formatLaws handles item with no latestAction', () => {
    const text = textOf(
      formatLaws({
        data: [{ congress: 118, type: 'HR', number: '5', title: 'Test Act' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Test Act');
    expect(text).not.toContain('Latest Action:');
  });

  it('formatVotes handles vote list with no result field', () => {
    const text = textOf(
      formatVotes({
        data: [
          {
            rollCallNumber: 55,
            voteType: 'Yea-And-Nay',
            startDate: '2026-01-10T14:00:00Z',
            congress: 119,
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Roll 55');
  });

  it('formatCommitteeReports handles report with no citation', () => {
    const text = textOf(
      formatCommitteeReports({
        data: [{ congress: 118, type: 'HRPT', number: 1, chamber: 'House' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    // Should render without crashing; shows whatever heading fallback applies
    expect(text).toBeDefined();
  });

  it('formatNominations handles nomination with no nominationType', () => {
    const text = textOf(
      formatNominations({
        data: [{ citation: 'PN500', congress: 119 }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('PN500');
  });

  it('formatCrsReports handles item with no date fields', () => {
    const text = textOf(
      formatCrsReports({
        data: [{ id: 'R11111', title: 'Report Without Dates' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('R11111');
    expect(text).toContain('Report Without Dates');
  });
});

// ── Pagination edge cases ─────────────────────────────────────────────────────

describe('pagination edge cases', () => {
  it('shows singular "result" for exactly 1 item', () => {
    const text = textOf(
      formatBills({
        data: [{ congress: 119, type: 'HR', number: '1', title: 'Single Bill' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**1 result**');
  });

  it('shows plural "results" for 0 items', () => {
    const text = textOf(formatBills({ data: [], pagination: { count: 0, nextOffset: null } }));
    expect(text).toContain('**0 results**');
  });

  it('shows plural "results" for 2+ items', () => {
    const text = textOf(
      formatBills({
        data: [
          { congress: 119, type: 'HR', number: '1', title: 'Bill A' },
          { congress: 119, type: 'HR', number: '2', title: 'Bill B' },
        ],
        pagination: { count: 2, nextOffset: null },
      }),
    );
    expect(text).toContain('**2 results**');
  });

  it('formats daily record with pagination correctly', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{ volumeNumber: 172, issueNumber: '1', issueDate: '2026-01-03' }],
        pagination: { count: 100, nextOffset: 1 },
      }),
    );
    expect(text).toContain('**100 results**');
    expect(text).toContain('next offset: 1');
  });
});

// ── formatMembers: terms rendering ───────────────────────────────────────────

/**
 * A member `list` row carries `terms.item` as one entry per continuous span of
 * service in a chamber, with no `endYear` on a span still being served (#123).
 */
describe('formatMembers — service spans on list rows (issue #123)', () => {
  const listRow = (row: Record<string, unknown>) =>
    textOf(formatMembers({ data: [row], pagination: { count: 1, nextOffset: null } }));
  /** The row's rendered lines, so an assertion pins a whole line. */
  const linesOf = (row: Record<string, unknown>) => listRow(row).split('\n');

  /** /member/WA/9?currentMember=true (2026-11-11). */
  const SMITH = {
    bioguideId: 'S000510',
    name: 'Smith, Adam',
    partyName: 'Democratic',
    state: 'Washington',
    district: 9,
    terms: { item: [{ chamber: 'House of Representatives', startYear: 1997 }] },
  };

  /** /member?stateCode=WA (2026-11-11): a House span, then a Senate span still open. */
  const CANTWELL = {
    bioguideId: 'C000127',
    name: 'Cantwell, Maria',
    partyName: 'Democratic',
    state: 'Washington',
    terms: {
      item: [
        { chamber: 'House of Representatives', endYear: 1995, startYear: 1993 },
        { chamber: 'Senate', startYear: 2001 },
      ],
    },
  };

  it('renders a span with no end year as still being served', () => {
    expect(linesOf(SMITH)).toContain('**Service:** House of Representatives, 1997–present');
    expect(listRow(SMITH)).not.toContain('Latest Term');
  });

  it('lists every span in order, and the fall-through does not repeat them', () => {
    expect(linesOf(CANTWELL)).toContain(
      '**Service:** House of Representatives, 1993–1995; Senate, 2001–present',
    );
    expect(listRow(CANTWELL)).not.toContain('terms:');
    expect(listRow(CANTWELL)).not.toContain('(2 total)');
  });

  it('reads a flat array of spans as the wrapped shape', () => {
    expect(linesOf({ ...CANTWELL, terms: CANTWELL.terms.item })).toContain(
      '**Service:** House of Representatives, 1993–1995; Senate, 2001–present',
    );
  });

  it('renders a span field the line does not name on that span', () => {
    const lines = linesOf({
      bioguideId: 'S000148',
      name: 'Schumer, Charles E.',
      terms: {
        item: [
          {
            chamber: 'House of Representatives',
            endYear: 1999,
            memberType: 'Representative',
            startYear: 1981,
          },
          { chamber: 'Senate', startYear: 1999 },
        ],
      },
    });
    expect(lines).toContain(
      '**Service:** House of Representatives, 1981–1999 — memberType: Representative; Senate, 1999–present',
    );
  });

  it('renders no Service line for a row without terms', () => {
    const text = listRow({ bioguideId: 'S000510', name: 'Smith, Adam' });
    expect(text).not.toContain('**Service:**');
  });
});

describe('formatMembers — terms on member detail', () => {
  /** /member/C000127 (2026-11-11), trimmed to its last two terms. */
  const text = textOf(
    formatMembers({
      member: {
        bioguideId: 'C000127',
        directOrderName: 'Maria Cantwell',
        terms: [
          {
            chamber: 'Senate',
            congress: 118,
            endYear: 2025,
            memberType: 'Senator',
            startYear: 2023,
            stateCode: 'WA',
            stateName: 'Washington',
          },
          {
            chamber: 'Senate',
            congress: 119,
            memberType: 'Senator',
            startYear: 2025,
            stateCode: 'WA',
            stateName: 'Washington',
          },
        ],
      },
    }),
  );

  it('renders a term with no end year as still being served', () => {
    expect(text).toContain('- Senate, 2025–present, Washington — congress: 119');
  });

  it('renders a closed term with both years', () => {
    expect(text).toContain('- Senate, 2023–2025, Washington — congress: 118');
  });
});

// ── Text versions: each row is headed by the textVersionIndex it carries ─────

/**
 * The `text` handlers stamp each row with the 0-based `textVersionIndex` that
 * `content` reads it by (`text-version-index.ts`); `format()` heads the row with
 * that field, never with a position worked out from the page.
 */
describe('text version rows are headed by their stamped textVersionIndex', () => {
  /** /bill/119/hr/1/text (2026-11-11), each row stamped with its index. */
  const HR1 = [
    ['Enrolled Bill', null],
    ['Engrossed Amendment Senate', '2025-07-01T04:00:00Z'],
    ['Placed on Calendar Senate', '2025-06-28T04:00:00Z'],
    ['Engrossed in House', '2025-05-22T04:00:00Z'],
    ['Reported in House', '2025-05-20T04:00:00Z'],
    ['Public Law', '2025-07-05T03:59:59Z'],
  ].map(([type, date], textVersionIndex) => ({
    date,
    formats: [{ type: 'Formatted Text', url: `https://www.congress.gov/119/${type}.htm` }],
    type,
    textVersionIndex,
  }));

  /** The headings of a rendered page, in order. */
  const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('### '));

  const billPage = (rows: typeof HR1, nextOffset: number | null) =>
    textOf(formatBills({ data: rows, pagination: { count: 6, nextOffset } }));

  it('heads a middle page by its own indices', () => {
    expect(headings(billPage([HR1[2]!, HR1[3]!], 4))).toEqual([
      '### textVersionIndex 2: Placed on Calendar Senate',
      '### textVersionIndex 3: Engrossed in House',
    ]);
  });

  it('heads the page that covers the Public Law version by its own indices', () => {
    expect(headings(billPage([HR1[4]!, HR1[5]!], null))).toEqual([
      '### textVersionIndex 4: Reported in House',
      '### textVersionIndex 5: Public Law',
    ]);
  });

  it('heads the Public Law version alone at its own index', () => {
    expect(headings(billPage([HR1[5]!], null))).toEqual(['### textVersionIndex 5: Public Law']);
  });

  it('renders the index once, in the heading, beside every other field', () => {
    const text = billPage([HR1[0]!], 1);
    expect(text).not.toContain('**textVersionIndex:**');
    expect(text).toContain('**Formatted Text:** https://www.congress.gov/119/Enrolled Bill.htm');
  });

  it('heads amendment text versions the same way', () => {
    const versions = [
      { date: '2008-03-14T00:55:21Z', formats: [], type: 'Proposed', textVersionIndex: 0 },
      { date: '2008-03-12T04:00:00Z', formats: [], type: 'Submitted', textVersionIndex: 1 },
    ];
    expect(
      headings(
        textOf(
          formatAmendments({ data: versions.slice(1), pagination: { count: 2, nextOffset: null } }),
        ),
      ),
    ).toEqual(['### textVersionIndex 1: Submitted']);
  });
});

// ── formatCommittees: list rendering ─────────────────────────────────────────

describe('formatCommittees — list operation', () => {
  it('renders multiple committees correctly', () => {
    const text = textOf(
      formatCommittees({
        data: [
          { name: 'Judiciary Committee', systemCode: 'hsju00', chamber: 'House' },
          { name: 'Finance Committee', systemCode: 'ssfi00', chamber: 'Senate' },
        ],
        pagination: { count: 2, nextOffset: null },
      }),
    );
    expect(text).toContain('**2 results**');
    expect(text).toContain('Judiciary Committee');
    expect(text).toContain('Finance Committee');
  });

  it('shows chamber in committee list items', () => {
    const text = textOf(
      formatCommittees({
        data: [{ name: 'Armed Services', systemCode: 'hsas00', chamber: 'House' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('House');
  });
});

// ── formatDailyRecord: date parsing edge cases ────────────────────────────────

describe('formatDailyRecord — issue date rendering', () => {
  it('extracts date portion from full ISO datetime in issueDate', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{ volumeNumber: 172, issueNumber: '68', issueDate: '2026-04-17T04:00:00Z' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    // Should render just the date portion in the heading
    expect(text).toContain('2026-04-17');
  });

  it('renders without issueNumber gracefully', () => {
    const text = textOf(
      formatDailyRecord({
        data: [{ volumeNumber: 172, issueDate: '2026-04-17' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('Volume 172');
  });
});

// ── formatVotes: list with multiple votes ─────────────────────────────────────

describe('formatVotes — multiple votes rendering', () => {
  it('renders multiple roll call votes with distinct headings', () => {
    const text = textOf(
      formatVotes({
        data: [
          { rollCallNumber: 100, result: 'Passed', congress: 119 },
          { rollCallNumber: 101, result: 'Failed', congress: 119 },
        ],
        pagination: { count: 2, nextOffset: null },
      }),
    );
    expect(text).toContain('Roll 100');
    expect(text).toContain('Roll 101');
    expect(text).toContain('Passed');
    expect(text).toContain('Failed');
  });
});

// ── formatCommitteeReports: detail operation ──────────────────────────────────

describe('formatCommitteeReports — detail mode', () => {
  it('renders report detail with all fields', () => {
    const text = textOf(
      formatCommitteeReports({
        report: {
          title: 'Economic Development Act Report',
          congress: 118,
          chamber: 'House',
          type: 'HRPT',
          number: 200,
          citation: 'H. Rept. 118-200',
          updateDate: '2024-05-01T00:00:00Z',
        },
      }),
    );
    expect(text).toContain('Economic Development Act Report');
    expect(text).toContain('118');
  });

  it('handles committee report text with no errata markers', () => {
    const text = textOf(
      formatCommitteeReports({
        text: [
          {
            formats: [{ isErrata: 'N', type: 'HTML', url: 'https://example.gov/report.html' }],
          },
        ],
      }),
    );
    expect(text).toContain('HTML');
    expect(text).not.toContain('Errata');
  });
});

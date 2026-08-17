/**
 * @fileoverview Output-fidelity coverage for `format-helpers`: the public/private
 * law citation on enacted-law list rows, complete detail rendering with no silent
 * field omission or value truncation, and inline-emphasis boundary whitespace in
 * the HTML→Markdown converter.
 *
 * Resolves cyanheads/congressgov-mcp-server#45, #50, #51.
 *
 * @module tests/mcp-server/tools/format-helpers-fidelity.test
 */

import { describe, expect, it } from 'vitest';

import {
  formatBills,
  formatCommittees,
  formatCrsReports,
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

// ── Fixtures ────────────────────────────────────────────────────────

/** `count` consecutive two-year House terms starting in 1987. */
function houseTerms(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    chamber: 'House of Representatives',
    congress: 100 + i,
    startYear: String(1987 + i * 2),
    endYear: String(1989 + i * 2),
    memberType: 'Representative',
    stateName: 'California',
    partyName: 'Democratic',
  }));
}

/** Member `get` payload with the sub-objects the detail renderer historically dropped. */
const memberDetailFixture: Record<string, unknown> = {
  bioguideId: 'P000197',
  directOrderName: 'Nancy Pelosi',
  invertedOrderName: 'Pelosi, Nancy',
  honorificName: 'Ms.',
  partyName: 'Democratic',
  state: 'California',
  district: 11,
  currentMember: true,
  birthYear: '1940',
  updateDate: '2026-05-01T00:00:00Z',
  addressInformation: {
    officeAddress: '1236 Longworth House Office Building',
    city: 'Washington',
    district: 'DC',
    zipCode: 20515,
    phoneNumber: '(202) 225-4965',
  },
  previousNames: [
    {
      directOrderName: 'Nancy P. Pelosi',
      invertedOrderName: 'Pelosi, Nancy P.',
      startDate: '1987-06-02T00:00:00Z',
      endDate: '1991-01-03T00:00:00Z',
    },
    {
      directOrderName: 'Nancy Patricia Pelosi',
      invertedOrderName: 'Pelosi, Nancy Patricia',
      startDate: '1991-01-03T00:00:00Z',
      endDate: '2003-01-07T00:00:00Z',
    },
    {
      directOrderName: 'Nancy D. Pelosi',
      invertedOrderName: 'Pelosi, Nancy D.',
      startDate: '2003-01-07T00:00:00Z',
      endDate: '2013-01-03T00:00:00Z',
    },
  ],
  officialWebsiteUrl: 'https://pelosi.house.gov',
  terms: houseTerms(20),
  partyHistory: [{ partyName: 'Democratic', partyAbbreviation: 'D', startYear: 1987 }],
  leadership: Array.from({ length: 12 }, (_, i) => ({
    type: i % 2 === 0 ? 'Speaker of the House' : 'Minority Leader',
    congress: 110 + i,
  })),
  sponsoredLegislation: { count: 132, url: 'https://api.congress.gov/v3/member/P000197/sponsored' },
  cosponsoredLegislation: {
    count: 2410,
    url: 'https://api.congress.gov/v3/member/P000197/cosponsored',
  },
  url: 'https://api.congress.gov/v3/member/P000197?format=json',
};

/** A real Congress.gov related-material title, long enough to trip the old inline cap. */
const LONG_RELATED_TITLE =
  'An original bill to authorize appropriations for fiscal year 2027 for military activities of the Department of Defense, for military construction, and for defense activities of the Department of Energy, to prescribe military personnel strengths for such fiscal year, and for other purposes.';

// ── Characterization: behavior held across the fidelity fixes ────────

describe('characterization — member detail structure', () => {
  const text = textOf(formatMembers({ member: memberDetailFixture }));

  it('keeps the name heading and identity metadata', () => {
    expect(text.startsWith('# Nancy Pelosi')).toBe(true);
    expect(text).toContain('**ID:** P000197');
    expect(text).toContain('**Party:** Democratic');
    expect(text).toContain('**State:** California');
    expect(text).toContain('**District:** 11');
    expect(text).toContain('**Currently Serving:** true');
    expect(text).toContain('**Birth Year:** 1940');
    expect(text).toContain('**Honorific:** Ms.');
  });

  it('keeps the curated terms, party-history, leadership, and legislation blocks', () => {
    expect(text).toContain('**Terms (20):**');
    expect(text).toContain('**Party History:**');
    expect(text).toContain('- Democratic (1987)');
    expect(text).toContain('**Leadership Roles (12):**');
    expect(text).toContain('- Speaker of the House — Congress 110');
    expect(text).toContain('**Legislation:** 132 sponsored, 2410 cosponsored');
    expect(text).toContain('**URL:** https://api.congress.gov/v3/member/P000197?format=json');
  });
});

describe('characterization — htmlToMarkdown structure', () => {
  const text = textOf(
    formatSummaries({
      data: [
        {
          actionDate: '2026-08-04',
          actionDesc: 'Introduced in House',
          text: '<p>First paragraph with <strong>bold</strong> and a <a href="https://www.congress.gov/">link</a>.</p><p>Second paragraph &amp; an entity.</p>',
          bill: { congress: 119, type: 'HR', number: '322', title: 'Sample Act' },
        },
      ],
      pagination: { count: 1, nextOffset: null },
    }),
  );

  it('preserves paragraph breaks, emphasis markers, links, and decoded entities', () => {
    expect(text).toContain('**bold**');
    expect(text).toContain('[link](https://www.congress.gov/)');
    expect(text).toContain('Second paragraph & an entity.');
    expect(text).toContain('First paragraph');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('&amp;');
  });
});

describe('characterization — law list rows keep bill identity', () => {
  const text = textOf(
    formatLaws({
      data: [
        {
          congress: 118,
          type: 'S',
          number: '3764',
          originChamber: 'Senate',
          title: 'United States Commission on International Religious Freedom Reauthorization Act',
          latestAction: { actionDate: '2024-09-30', text: 'Became Public Law No: 118-90.' },
          updateDate: '2024-10-01T00:00:00Z',
          url: 'https://api.congress.gov/v3/law/118/pub/90?format=json',
          laws: [{ number: '118-90', type: 'Public Law' }],
        },
      ],
      pagination: { count: 1, nextOffset: null },
    }),
  );

  it('renders the bill heading, chamber, latest action, and URL', () => {
    expect(text).toContain(
      '### 1. S 3764: United States Commission on International Religious Freedom Reauthorization Act',
    );
    expect(text).toContain('**Congress:** 118 | **Chamber:** Senate');
    expect(text).toContain('**Latest Action:** 2024-09-30 — Became Public Law No: 118-90.');
    expect(text).toContain('**URL:** https://api.congress.gov/v3/law/118/pub/90?format=json');
  });
});

// ── #45 — law citation on list rows ─────────────────────────────────

describe('#45 — enacted-laws list renders the public/private law citation', () => {
  it('renders the public law citation on a list row', () => {
    const text = textOf(
      formatLaws({
        data: [
          {
            congress: 118,
            type: 'S',
            number: '3764',
            title: 'Reauthorization Act of 2024',
            laws: [{ number: '118-90', type: 'Public Law' }],
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Law:** Public Law 118-90');
  });

  it('renders the private law citation on a list row', () => {
    const text = textOf(
      formatLaws({
        data: [
          {
            congress: 118,
            type: 'HR',
            number: '1234',
            title: 'For the relief of a named individual',
            laws: [{ number: '118-3', type: 'Private Law' }],
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Law:** Private Law 118-3');
  });

  it('joins multiple citations and tolerates a missing type', () => {
    const text = textOf(
      formatLaws({
        data: [
          {
            congress: 118,
            type: 'HR',
            number: '9',
            title: 'Two-Law Act',
            laws: [{ number: '118-1', type: 'Public Law' }, { number: '118-2' }],
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Law:** Public Law 118-1, 118-2');
  });

  it('omits the citation line when the row carries no laws', () => {
    const text = textOf(
      formatLaws({
        data: [{ congress: 118, type: 'HR', number: '5', title: 'Not Yet Enacted Act' }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).not.toContain('**Law:**');
  });

  it('renders the citation on bill list rows that carry laws too', () => {
    const text = textOf(
      formatBills({
        data: [
          {
            congress: 118,
            type: 'HR',
            number: '1',
            title: 'Enacted Bill Act',
            laws: [{ number: '118-42', type: 'Public Law' }],
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('**Law:** Public Law 118-42');
  });

  it('still renders the citation on the law detail view', () => {
    const text = textOf(
      formatLaws({
        law: {
          congress: 118,
          type: 'S',
          number: '3764',
          title: 'Reauthorization Act of 2024',
          laws: [{ number: '118-90', type: 'Public Law' }],
        },
      }),
    );
    expect(text).toContain('**Law:** Public Law 118-90');
  });
});

// ── #50 — no silent omission or truncation in detail output ─────────

describe('#50 — member detail carries every upstream field', () => {
  const text = textOf(formatMembers({ member: memberDetailFixture }));

  it('renders addressInformation', () => {
    expect(text).toContain('1236 Longworth House Office Building');
    expect(text).toContain('(202) 225-4965');
    expect(text).toContain('20515');
  });

  it('renders every previous name', () => {
    expect(text).toContain('Nancy P. Pelosi');
    expect(text).toContain('Nancy Patricia Pelosi');
    expect(text).toContain('Nancy D. Pelosi');
  });

  it('renders fields the curated header never named', () => {
    expect(text).toContain('https://pelosi.house.gov');
  });

  it('renders all 20 terms rather than the last five', () => {
    for (const term of houseTerms(20)) {
      expect(text).toContain(`${term.startYear as string}–${term.endYear as string}`);
    }
    expect(text).not.toContain('earlier_');
  });

  it('renders all 12 leadership roles', () => {
    expect(text).toContain('Congress 110');
    expect(text).toContain('Congress 121');
    expect(text).not.toContain('more_');
  });
});

describe('#50 — curated sub-collection rows keep the fields the curation never names', () => {
  /** Live shape: a term row carries congress, district, memberType, and stateCode
   * alongside the four fields the curated line spells out. Redistricting moves
   * `district` between terms, so it is not recoverable from the header's value. */
  const termFixture = {
    chamber: 'House of Representatives',
    congress: 100,
    district: 5,
    endYear: 1989,
    memberType: 'Representative',
    startYear: 1987,
    stateCode: 'CA',
    stateName: 'California',
  };

  it('renders the term fields the curated line never names', () => {
    const text = textOf(
      formatMembers({
        member: { bioguideId: 'P000197', district: 11, terms: [termFixture] },
      }),
    );
    expect(text).toContain('House of Representatives, 1987–1989, California');
    expect(text).toContain('congress: 100');
    expect(text).toContain('district: 5');
    expect(text).toContain('memberType: Representative');
    expect(text).toContain('stateCode: CA');
  });

  it('renders the party-history fields the curated line never names', () => {
    const text = textOf(
      formatMembers({
        member: {
          bioguideId: 'M000355',
          partyHistory: [{ partyAbbreviation: 'R', partyName: 'Republican', startYear: 1985 }],
        },
      }),
    );
    expect(text).toContain('- Republican (1985)');
    expect(text).toContain('partyAbbreviation: R');
  });

  it('renders the nominee sub-resource URL the curated line never names', () => {
    const text = textOf(
      formatNominations({
        nomination: {
          citation: 'PN730-2',
          nominees: [
            {
              nomineeCount: 1,
              ordinal: 1,
              organization: 'Federal Labor Relations Authority',
              positionTitle: 'General Counsel of the Federal Labor Relations Authority',
              url: 'https://api.congress.gov/v3/nomination/119/730-2/1?format=json',
            },
          ],
        },
      }),
    );
    expect(text).toContain('Ord 1 — 1 nominee(s) — Federal Labor Relations Authority');
    expect(text).toContain('https://api.congress.gov/v3/nomination/119/730-2/1?format=json');
  });

  it('adds no suffix when the curated line already names every field', () => {
    const text = textOf(
      formatMembers({
        member: { bioguideId: 'M000355', leadership: [{ congress: 114, type: 'Majority Leader' }] },
      }),
    );
    expect(text).toContain('- Majority Leader — Congress 114');
    expect(text).not.toContain('type: Majority Leader');
    expect(text).not.toContain('congress: 114');
  });
});

describe('#50 — nested string values are not cut mid-value', () => {
  it('renders a long CRS related-material title in full', () => {
    const text = textOf(
      formatCrsReports({
        report: {
          id: 'IF12610',
          title: 'Defense Primer',
          relatedMaterials: [
            { title: LONG_RELATED_TITLE, url: 'https://www.congress.gov/bill/119/s/2296' },
          ],
        },
      }),
    );
    expect(text).toContain(LONG_RELATED_TITLE);
    expect(text).not.toContain('Department of Defens...');
  });

  it('renders every item of a nested array longer than twenty entries', () => {
    const materials = Array.from({ length: 25 }, (_, i) => ({
      title: `Related material number ${i + 1}`,
      url: `https://www.congress.gov/related/${i + 1}`,
    }));
    const text = textOf(
      formatCrsReports({
        report: { id: 'R40000', title: 'Long List', relatedMaterials: materials },
      }),
    );
    for (const m of materials) expect(text).toContain(m.title as string);
    expect(text).not.toContain('5 more_');
  });

  it('renders nested objects past the first level', () => {
    const text = textOf(
      formatCrsReports({
        report: {
          id: 'R40001',
          title: 'Nested',
          topics: [
            {
              name: 'Defense',
              parent: { name: 'National Security', code: 'NS', description: LONG_RELATED_TITLE },
            },
          ],
        },
      }),
    );
    expect(text).toContain('Defense');
    expect(text).toContain('National Security');
    expect(text).toContain(LONG_RELATED_TITLE);
  });
});

describe('#50 — generic list rows keep every nested sub-item', () => {
  it('renders more than five nested sub-items', () => {
    const sub = Array.from({ length: 8 }, (_, i) => ({
      name: `Sub-item ${i + 1}`,
      code: `SC${i + 1}`,
    }));
    const text = textOf(
      formatCommittees({
        data: [{ recordId: 'X1', relatedEntries: sub }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    for (const s of sub) expect(text).toContain(s.name);
    expect(text).not.toContain('3 more_');
  });
});

describe('#50 — roll call vote detail carries every upstream field', () => {
  const text = textOf(
    formatVotes({
      vote: {
        rollCallNumber: 240,
        identifier: 240,
        congress: 119,
        sessionNumber: 1,
        result: 'Passed',
        voteQuestion: 'On Motion to Suspend the Rules and Pass',
        voteType: '2/3 Yea-And-Nay',
        startDate: '2025-09-08T18:56:00-04:00',
        updateDate: '2025-09-09T01:00:00Z',
        legislationType: 'HR',
        legislationNumber: '3424',
        legislationUrl: 'https://www.congress.gov/bill/119/house-bill/3424',
        url: 'https://api.congress.gov/v3/house-vote/119/1/240?format=json',
        sourceDataURL: 'https://clerk.house.gov/Votes/2025240.xml',
        votePartyTotal: [
          {
            party: { name: 'Republican' },
            yeaTotal: 200,
            nayTotal: 10,
            presentTotal: 0,
            notVotingTotal: 5,
          },
        ],
      },
    }),
  );

  it('keeps the curated header and party totals', () => {
    expect(text).toContain('# Roll 240 — Passed');
    expect(text).toContain('**Question:** On Motion to Suspend the Rules and Pass');
    expect(text).toContain('- **Republican:** Yea 200, Nay 10, Present 0, Not Voting 5');
    expect(text).toContain('**Source Data URL:** https://clerk.house.gov/Votes/2025240.xml');
  });

  it('renders the associated legislation and record URL the header never named', () => {
    expect(text).toContain('3424');
    expect(text).toContain('https://www.congress.gov/bill/119/house-bill/3424');
    expect(text).toContain('https://api.congress.gov/v3/house-vote/119/1/240?format=json');
  });
});

describe('#50 — Senate vote detail carries every upstream field', () => {
  const text = textOf(
    formatVotes({
      chamber: 'senate',
      vote: {
        chamber: 'senate',
        congress: 118,
        session: 2,
        voteNumber: 1,
        voteDate: 'January 8, 2024, 05:27 PM',
        modifyDate: 'January 9, 2024, 09:00 AM',
        question: 'On the Cloture Motion',
        voteQuestionText: 'On the Cloture Motion PN1020',
        voteTitle: 'Motion to Invoke Cloture: John A. Kazen',
        voteResult: 'Cloture Motion Agreed to',
        voteResultText: 'Cloture Motion Agreed to (73-15)',
        majorityRequirement: '1/2',
        count: { yeas: 73, nays: 15, present: 0, absent: 12 },
        partyTotals: [{ party: 'R', yea: 25, nay: 15, present: 0, notVoting: 9 }],
        document: {
          congress: 118,
          type: 'PN',
          number: '1020',
          name: 'PN1020',
          title: 'John A. Kazen, of Texas',
        },
        voteDocumentText: 'John A. Kazen, of Texas',
      },
    }),
  );

  it('keeps the curated header, tally, and document line', () => {
    expect(text).toContain('# Senate Vote 1 — Cloture Motion Agreed to (73-15)');
    expect(text).toContain('**Tally:** Yea 73 · Nay 15 · Present 0 · Not Voting 12');
    expect(text).toContain('**Document:** PN — PN1020 — John A. Kazen, of Texas');
  });

  it('renders modifyDate, which the curated header never named', () => {
    expect(text).toContain('January 9, 2024, 09:00 AM');
  });

  it('does not repeat the matter narrative already shown as the document title', () => {
    expect(text.match(/John A\. Kazen, of Texas/g)).toHaveLength(1);
  });

  it('renders the amendment short title alongside the amendment reference', () => {
    const amdText = textOf(
      formatVotes({
        chamber: 'senate',
        vote: {
          chamber: 'senate',
          voteNumber: 336,
          voteResultText: 'Amendment Rejected (34-62)',
          count: { yeas: 34, nays: 62, present: 0, absent: 4 },
          amendment: {
            number: 'S.Amdt. 3331',
            toDocumentNumber: 'H.R. 82',
            toDocumentShortTitle: 'Social Security Fairness Act',
            purpose: 'To delay the repeal of the Government pension offset.',
          },
        },
      }),
    );
    expect(amdText).toContain('**Amendment:** S.Amdt. 3331 to H.R. 82');
    expect(amdText).toContain('Social Security Fairness Act');
    expect(amdText).toContain('**Purpose:** To delay the repeal of the Government pension offset.');
  });
});

describe('#50 — nomination detail carries every upstream field', () => {
  const nominees = Array.from({ length: 25 }, (_, i) => ({
    ordinal: i + 1,
    nomineeCount: 1,
    organization: `Bureau ${i + 1}`,
    positionTitle: `Position ${i + 1}`,
  }));
  const text = textOf(
    formatNominations({
      nomination: {
        citation: 'PN851-1',
        number: 851,
        partNumber: '01',
        congress: 119,
        nominationType: { isCivilian: true },
        description: 'Nominee description',
        receivedDate: '2026-01-05',
        authorityDate: '2026-01-05',
        updateDate: '2026-05-19T00:00:00Z',
        latestAction: { actionDate: '2026-05-19', text: 'Confirmed by the Senate.' },
        organization: 'Department of Justice',
        executiveCalendarNumber: '412',
        isPrivileged: false,
        nominees,
        url: 'https://api.congress.gov/v3/nomination/119/851-1?format=json',
      },
    }),
  );

  it('keeps the curated heading, description, and metadata', () => {
    expect(text).toContain('# PN851-1');
    expect(text).toContain('Nominee description');
    expect(text).toContain('**Congress:** 119 | **Type:** Civilian');
    expect(text).toContain('**Latest Action:** 2026-05-19 — Confirmed by the Senate.');
  });

  it('renders all 25 nominee entries', () => {
    expect(text).toContain('Position 1');
    expect(text).toContain('Position 25');
    expect(text).not.toContain('5 more_');
  });

  it('renders fields the curated header never named', () => {
    expect(text).toContain('Department of Justice');
    expect(text).toContain('412');
    expect(text).toContain('false');
  });
});

// ── #51 — inline-emphasis boundary whitespace ───────────────────────

const EMPHASIS_HTML =
  '<p>The bill provides <em>de minimis </em>treatment for an<em> de minimis</em> threshold and <strong>major </strong>changes to<strong> other </strong>rules.</p>';

describe('#51 — inline emphasis keeps whitespace outside the markers', () => {
  const text = textOf(
    formatSummaries({
      data: [
        {
          actionDate: '2026-08-04',
          text: EMPHASIS_HTML,
          bill: { congress: 119, type: 'HR', number: '322' },
        },
      ],
      pagination: { count: 1, nextOffset: null },
    }),
  );

  it('moves a trailing space out of an <em> span', () => {
    expect(text).toContain('*de minimis* treatment');
    expect(text).not.toContain('*de minimis *');
  });

  it('moves a leading space out of an <em> span', () => {
    expect(text).toContain('an *de minimis* threshold');
    expect(text).not.toContain('an* de minimis*');
  });

  it('applies the same normalization to <strong> spans', () => {
    expect(text).toContain('**major** changes');
    expect(text).not.toContain('**major **');
    expect(text).toContain('to **other** rules');
    expect(text).not.toContain('to** other **');
  });

  it('normalizes the bill_lookup summaries sub-resource the same way', () => {
    const subText = textOf(
      formatBills({
        data: [
          {
            actionDesc: 'Introduced in House',
            actionDate: '2026-08-04',
            updateDate: '2026-08-05T00:00:00Z',
            text: EMPHASIS_HTML,
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(subText).toContain('### 1. Introduced in House');
    expect(subText).toContain('*de minimis* treatment');
    expect(subText).toContain('**major** changes');
    expect(subText).not.toContain('*de minimis *');
    expect(subText).not.toContain('**major **');
  });

  it('handles <i> and <b> aliases', () => {
    const aliasText = textOf(
      formatSummaries({
        data: [
          {
            text: '<p>an<i> italic </i>word and a<b> bold </b>word</p>',
            bill: { congress: 119, type: 'HR', number: '1' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(aliasText).toContain('an *italic* word');
    expect(aliasText).toContain('a **bold** word');
  });

  it('emits no markers for an empty or whitespace-only span', () => {
    const emptyText = textOf(
      formatSummaries({
        data: [
          {
            text: '<p>before<em></em>after and one<strong> </strong>space</p>',
            bill: { congress: 119, type: 'HR', number: '2' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(emptyText).toContain('beforeafter and one space');
    expect(emptyText).not.toContain('before*');
    expect(emptyText).not.toContain('one* ');
  });

  it('drops an unclosed emphasis tag without leaving a stray marker', () => {
    const strayText = textOf(
      formatSummaries({
        data: [
          {
            text: '<p>unbalanced <em>markup with no close</p>',
            bill: { congress: 119, type: 'HR', number: '3' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(strayText).toContain('unbalanced markup with no close');
    expect(strayText).not.toContain('unbalanced *');
  });

  it('nests emphasis inside strong', () => {
    const nestedText = textOf(
      formatSummaries({
        data: [
          {
            text: '<p>a <strong>bold <em>and italic</em></strong> phrase</p>',
            bill: { congress: 119, type: 'HR', number: '4' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(nestedText).toContain('**bold *and italic***');
  });

  it('keeps a link inside an emphasis span', () => {
    const linkText = textOf(
      formatSummaries({
        data: [
          {
            text: '<p>see <em><a href="https://www.congress.gov/">the record </a></em>today</p>',
            bill: { congress: 119, type: 'HR', number: '5' },
          },
        ],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(linkText).toContain('[the record ](https://www.congress.gov/)');
    expect(linkText).toContain('today');
  });
});

// ── Boundaries shared by the fidelity fixes ─────────────────────────

describe('boundaries — empty and past-the-end pages still read correctly', () => {
  it('reports zero matches on an empty law list', () => {
    const text = textOf(formatLaws({ data: [], pagination: { count: 0, nextOffset: null } }));
    expect(text).toContain('**0 results**');
    expect(text).toContain('No matching results');
    expect(text).not.toContain('**Law:**');
  });

  it('distinguishes a page past the end from zero matches', () => {
    const text = textOf(formatLaws({ data: [], pagination: { count: 12, nextOffset: null } }));
    expect(text).toContain('Page is empty');
    expect(text).toContain('past the end of 12 total items');
  });

  it('renders a summary row with no text without inventing one', () => {
    const text = textOf(
      formatSummaries({
        data: [{ actionDate: '2026-08-04', bill: { congress: 119, type: 'HR', number: '6' } }],
        pagination: { count: 1, nextOffset: null },
      }),
    );
    expect(text).toContain('_Summary text not available._');
  });

  it('renders a member detail with no terms, leadership, or address', () => {
    const text = textOf(formatMembers({ member: { bioguideId: 'X000001' } }));
    expect(text).toContain('# X000001');
    expect(text).not.toContain('**Terms');
    expect(text).not.toContain('**Leadership Roles');
  });
});

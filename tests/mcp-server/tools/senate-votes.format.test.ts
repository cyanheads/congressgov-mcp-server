/**
 * @fileoverview Tests for Senate vote rendering in formatVotes — list, detail, and
 * members views, plus the chamber dispatch that keeps House payloads on the House
 * renderers.
 * @module tests/mcp-server/tools/senate-votes.format.test
 */

import { describe, expect, it } from 'vitest';
import { formatVotes } from '@/mcp-server/tools/format-helpers.js';

const render = (result: Record<string, unknown>) => formatVotes(result)[0]!.text;

describe('formatVotes — Senate list', () => {
  const text = render({
    chamber: 'senate',
    data: [
      {
        chamber: 'senate',
        voteNumber: 339,
        issue: 'H.R. 10545',
        result: 'Passed',
        question: 'On Passage of the Bill',
        voteDate: '21-Dec',
        yeas: 85,
        nays: 11,
        title: 'H.R. 10545; A bill making further continuing appropriations.',
      },
      {
        chamber: 'senate',
        voteNumber: 336,
        issue: 'H.R. 82',
        result: 'Rejected',
        question: 'On the Amendment',
        measure: 'S.Amdt. 3331',
        voteDate: '20-Dec',
        yeas: 34,
        nays: 62,
        title: 'Crapo Amdt. No. 3331.',
      },
    ],
    pagination: { count: 339, nextOffset: 20 },
  });

  it('renders the pagination header and per-vote headings', () => {
    expect(text).toContain('**339 results** | next offset: 20');
    expect(text).toContain('### 1. Vote 339: H.R. 10545 — Passed');
    expect(text).toContain('**Date:** 21-Dec | **Yeas:** 85 | **Nays:** 11');
  });

  it('appends the amendment measure to the question', () => {
    expect(text).toContain('### 2. Vote 336: H.R. 82 — Rejected');
    expect(text).toContain('**Question:** On the Amendment (S.Amdt. 3331)');
  });
});

describe('formatVotes — Senate list dates', () => {
  const listRow = (row: Record<string, unknown>) =>
    render({
      chamber: 'senate',
      data: [{ chamber: 'senate', voteNumber: 292, yeas: 85, nays: 11, ...row }],
      pagination: { count: 1, nextOffset: null },
    });

  it('leads with the resolved date and keeps the menu form beside it', () => {
    expect(listRow({ voteDate: '01-Jan', voteDateIso: '2021-01-01' })).toContain(
      '**Date:** 2021-01-01 (01-Jan) | **Yeas:** 85 | **Nays:** 11',
    );
  });

  it('renders the menu date alone when no date could be resolved', () => {
    expect(listRow({ voteDate: '01-Jan' })).toContain(
      '**Date:** 01-Jan | **Yeas:** 85 | **Nays:** 11',
    );
  });

  it('renders the resolved date alone when the menu published none', () => {
    expect(listRow({ voteDateIso: '2021-01-01' })).toContain(
      '**Date:** 2021-01-01 | **Yeas:** 85 | **Nays:** 11',
    );
  });

  it('omits the date entirely when the row carries neither', () => {
    const text = listRow({});
    expect(text).toContain('**Yeas:** 85 | **Nays:** 11');
    expect(text).not.toContain('**Date:**');
  });
});

describe('formatVotes — Senate detail', () => {
  const text = render({
    chamber: 'senate',
    vote: {
      chamber: 'senate',
      congress: 118,
      session: 2,
      voteNumber: 1,
      voteDate: 'January 8, 2024, 05:27 PM',
      question: 'On the Cloture Motion',
      voteQuestionText: 'On the Cloture Motion PN1020',
      voteTitle: 'Motion to Invoke Cloture: John A. Kazen',
      voteResultText: 'Cloture Motion Agreed to (73-15)',
      majorityRequirement: '1/2',
      count: { yeas: 73, nays: 15, present: 0, absent: 12 },
      document: {
        congress: 118,
        type: 'PN',
        number: '1020',
        name: 'PN1020',
        title: 'John A. Kazen, of Texas',
      },
      voteDocumentText: 'John A. Kazen, of Texas',
      partyTotals: [
        { party: 'R', yea: 25, nay: 15, present: 0, notVoting: 9 },
        { party: 'D', yea: 45, nay: 0, present: 0, notVoting: 3 },
        { party: 'I', yea: 3, nay: 0, present: 0, notVoting: 0 },
      ],
    },
  });

  it('renders heading, question, tally, and party totals', () => {
    expect(text).toContain('# Senate Vote 1 — Cloture Motion Agreed to (73-15)');
    expect(text).toContain('**Question:** On the Cloture Motion PN1020');
    expect(text).toContain('**Tally:** Yea 73 · Nay 15 · Present 0 · Not Voting 12');
    expect(text).toContain('- **R:** Yea 25, Nay 15, Present 0, Not Voting 9');
  });

  it('renders the document reference', () => {
    expect(text).toContain('**Document:** PN — PN1020 — John A. Kazen, of Texas');
  });

  it('suppresses the matter narrative when it just repeats the document title', () => {
    /** "John A. Kazen, of Texas" appears once (in the Document line), not again as a
     * trailing paragraph. */
    expect(text.match(/John A\. Kazen, of Texas/g)).toHaveLength(1);
  });

  it('renders the amendment block for amendment votes', () => {
    const amdText = render({
      chamber: 'senate',
      vote: {
        chamber: 'senate',
        voteNumber: 336,
        voteResultText: 'Amendment Rejected (34-62, 3/5 majority required)',
        count: { yeas: 34, nays: 62, present: 0, absent: 4 },
        amendment: {
          number: 'S.Amdt. 3331',
          toDocumentNumber: 'H.R. 82',
          purpose: 'To delay the repeal of the Government pension offset.',
        },
      },
    });
    expect(amdText).toContain('**Amendment:** S.Amdt. 3331 to H.R. 82');
    expect(amdText).toContain('**Purpose:** To delay the repeal of the Government pension offset.');
  });
});

describe('formatVotes — Senate members', () => {
  const text = render({
    chamber: 'senate',
    data: [
      { chamber: 'senate', memberFull: 'Baldwin (D-WI)', voteCast: 'Yea' },
      { chamber: 'senate', memberFull: 'Barrasso (R-WY)', voteCast: 'Not Voting' },
      /** Fallback path: no pre-formatted memberFull. */
      {
        chamber: 'senate',
        firstName: 'Jane',
        lastName: 'Smith',
        party: 'D',
        state: 'CA',
        voteCast: 'Nay',
      },
    ],
    vote: {
      chamber: 'senate',
      voteNumber: 1,
      congress: 118,
      session: 2,
      voteQuestionText: 'On the Cloture Motion PN1020',
      voteResultText: 'Cloture Motion Agreed to (73-15)',
    },
    pagination: { count: 100, nextOffset: 3 },
  });

  it('renders the vote-context header and member range', () => {
    expect(text).toContain('# Senate Vote 1 — 118th Congress, session 2');
    expect(text).toContain('**On the Cloture Motion PN1020** — Cloture Motion Agreed to (73-15)');
    expect(text).toContain('**Members 1–3 of 100** · next offset: 3');
  });

  it('renders each position, using the pre-formatted label or the name fallback', () => {
    expect(text).toContain('- Baldwin (D-WI) → Yea');
    expect(text).toContain('- Barrasso (R-WY) → Not Voting');
    expect(text).toContain('- Jane Smith (D-CA) → Nay');
  });

  it('writes the congress as an English ordinal in the header (issue #94)', () => {
    const header = render({
      chamber: 'senate',
      data: [{ chamber: 'senate', memberFull: 'Baldwin (D-WI)', voteCast: 'Yea' }],
      vote: { chamber: 'senate', voteNumber: 7, congress: 102, session: 2 },
      pagination: { count: 100, nextOffset: 1 },
    });
    expect(header).toContain('# Senate Vote 7 — 102nd Congress, session 2');
    expect(header).not.toContain('102th');
  });

  it('renders no filter line on an unfiltered roster', () => {
    expect(text).not.toContain('Filter');
  });
});

describe('formatVotes — filtered Senate rosters (issue #102)', () => {
  const vote = {
    chamber: 'senate',
    voteNumber: 1,
    congress: 118,
    session: 2,
    voteQuestionText: 'On the Cloture Motion PN1020',
    voteResultText: 'Cloture Motion Agreed to (73-15)',
  };
  const king = {
    chamber: 'senate',
    memberFull: 'King (I-ME)',
    firstName: 'Angus',
    lastName: 'King',
    party: 'I',
    state: 'ME',
    voteCast: 'Yea',
    lisMemberId: 'S363',
  };

  it('names the filter and how many of the roster’s positions it matched', () => {
    const text = render({
      chamber: 'senate',
      data: [king],
      vote,
      pagination: { count: 2, nextOffset: 1 },
      memberFilter: { party: 'I', rosterCount: 100 },
    });
    expect(text).toContain('**Filter:** party=I — matches 2 of 100 member positions');
    expect(text).toContain('**Members 1–1 of 2** · next offset: 1');
    expect(text).toContain('- King (I-ME) → Yea');
  });

  it('says no position matched — not that none was recorded — when the filter matches nothing', () => {
    const text = render({
      chamber: 'senate',
      data: [],
      vote,
      pagination: { count: 0, nextOffset: null },
      memberFilter: { stateCode: 'ZZ', rosterCount: 100 },
    });
    expect(text).toContain('**Filter:** stateCode=ZZ — matches 0 of 100 member positions');
    expect(text).toContain('_No member position on this roll call matches the filter._');
    expect(text).not.toContain('No member positions recorded');
  });

  it('counts the matching positions when a filtered page runs past its end', () => {
    const text = render({
      chamber: 'senate',
      data: [],
      vote,
      pagination: { count: 2, nextOffset: null },
      memberFilter: { stateCode: 'ME', rosterCount: 100 },
    });
    expect(text).toContain(
      '_Page is empty — offset is past the end of 2 matching member positions._',
    );
  });
});

describe('formatVotes — Senate votes served from Voteview (issue #90)', () => {
  /** 119th Congress, session 2, vote 256 as Voteview publishes it: a date, no timestamp or document. */
  const voteviewVote = {
    chamber: 'senate',
    congress: 119,
    session: 2,
    voteNumber: 256,
    voteDateIso: '2026-09-30',
    question: 'On the Nomination',
    voteResult: 'Nomination Confirmed',
    voteDocumentText: 'Keith Sonderling, of Florida, to be Secretary of Labor',
    majorityRequirement: '1/2',
    issue: 'PN1129',
    count: { yeas: 47, nays: 41, present: 0, absent: 12 },
  };

  it('dates the detail from voteDateIso and adds the Issue line, each rendered once', () => {
    const text = render({
      chamber: 'senate',
      vote: {
        ...voteviewVote,
        partyTotals: [{ party: 'R', yea: 47, nay: 0, present: 0, notVoting: 6 }],
      },
    });
    expect(text).toContain('# Senate Vote 256 — Nomination Confirmed');
    expect(text).toContain('**Question:** On the Nomination');
    expect(text).toContain(
      '**Congress:** 119 | **Session:** 2 | **Date:** 2026-09-30 | **Majority Required:** 1/2 | **Issue:** PN1129',
    );
    expect(text).toContain('**Tally:** Yea 47 · Nay 41 · Present 0 · Not Voting 12');
    expect(text).toContain('\n\nKeith Sonderling, of Florida, to be Secretary of Labor');
    expect(text.match(/2026-09-30/g)).toHaveLength(1);
    expect(text.match(/PN1129/g)).toHaveLength(1);
    expect(text).not.toContain('**voteDateIso:**');
    expect(text).not.toContain('**issue:**');
  });

  it('leaves the Issue line out when Voteview names no measure', () => {
    const { issue: _issue, majorityRequirement: _majority, ...sparse } = voteviewVote;
    const text = render({ chamber: 'senate', vote: sparse });
    expect(text).toContain('**Congress:** 119 | **Session:** 2 | **Date:** 2026-09-30\n');
    expect(text).not.toContain('Issue');
  });

  it('names each senator from Voteview with party-state, position, and bioguide ID', () => {
    const text = render({
      chamber: 'senate',
      data: [
        {
          chamber: 'senate',
          name: 'CANTWELL, Maria E.',
          party: 'D',
          state: 'WA',
          voteCast: 'Nay',
          bioguideId: 'C000127',
        },
        {
          chamber: 'senate',
          name: 'KING, Angus Stanley, Jr.',
          party: 'I',
          state: 'ME',
          voteCast: 'Nay',
          bioguideId: 'K000383',
        },
        /** A row with no party: Voteview's party code is outside the ones this server maps. */
        { chamber: 'senate', name: 'SMITH, Jane', state: 'CA', voteCast: 'Yea' },
      ],
      vote: voteviewVote,
      pagination: { count: 100, nextOffset: 3 },
    });
    expect(text).toContain('# Senate Vote 256 — 119th Congress, session 2');
    expect(text).toContain('**On the Nomination** — Nomination Confirmed');
    expect(text).toContain('- CANTWELL, Maria E. (D-WA) → Nay — bioguideId: C000127');
    expect(text).toContain('- KING, Angus Stanley, Jr. (I-ME) → Nay — bioguideId: K000383');
    expect(text).toMatch(/^- SMITH, Jane \(CA\) → Yea$/m);
    /** The vote's Voteview-only fields reach the members view too. */
    expect(text).toContain('2026-09-30');
    expect(text).toContain('PN1129');
  });

  it('keeps a Voteview row without a name identifiable by its bioguide ID', () => {
    const text = render({
      chamber: 'senate',
      data: [
        { chamber: 'senate', party: 'D', state: 'WA', voteCast: 'Nay', bioguideId: 'C000127' },
      ],
      vote: voteviewVote,
      pagination: { count: 1, nextOffset: null },
    });
    expect(text).toContain('- ? (D-WA) → Nay — bioguideId: C000127');
  });
});

describe('formatVotes — LIS-shaped Senate records render as before (issue #90)', () => {
  it('dates an LIS detail from its timestamp, with no Issue line', () => {
    const text = render({
      chamber: 'senate',
      vote: {
        chamber: 'senate',
        congress: 118,
        session: 2,
        voteNumber: 1,
        voteDate: 'January 8, 2024, 05:27 PM',
        voteResultText: 'Cloture Motion Agreed to (73-15)',
        majorityRequirement: '1/2',
        count: { yeas: 73, nays: 15, present: 0, absent: 12 },
      },
    });
    expect(text).toContain(
      '**Congress:** 118 | **Session:** 2 | **Date:** January 8, 2024, 05:27 PM | **Majority Required:** 1/2\n',
    );
    expect(text).not.toContain('Issue');
  });

  it('names an LIS row by its member ID when it carries no name', () => {
    const text = render({
      chamber: 'senate',
      data: [{ chamber: 'senate', lisMemberId: 'S354', party: 'D', state: 'WI', voteCast: 'Yea' }],
      vote: { chamber: 'senate', voteNumber: 1, congress: 118, session: 2 },
      pagination: { count: 1, nextOffset: null },
    });
    expect(text).toMatch(/^- S354 \(D-WI\) → Yea$/m);
  });

  it('keeps the member ID beside an LIS row named by first and last name', () => {
    const text = render({
      chamber: 'senate',
      data: [
        {
          chamber: 'senate',
          firstName: 'Tammy',
          lastName: 'Baldwin',
          party: 'D',
          state: 'WI',
          voteCast: 'Yea',
          lisMemberId: 'S354',
        },
      ],
      vote: { chamber: 'senate', voteNumber: 1, congress: 118, session: 2 },
      pagination: { count: 1, nextOffset: null },
    });
    expect(text).toContain('- Tammy Baldwin (D-WI) → Yea — lisMemberId: S354');
  });
});

describe('formatVotes — chamber dispatch', () => {
  it('keeps a House detail (no chamber marker) on the House renderer', () => {
    const text = render({
      vote: { rollCallNumber: 42, voteQuestion: 'On Passage', result: 'Passed', congress: 119 },
    });
    expect(text).toContain('# Roll 42 — Passed');
    expect(text).not.toContain('Senate Vote');
  });
});

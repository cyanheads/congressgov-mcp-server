/**
 * @fileoverview Tests for Senate vote rendering in formatVotes — list, detail, and
 * members views, plus the chamber dispatch that keeps House payloads on the House
 * renderers.
 * @module tests/mcp-server/tools/senate-votes.format.test
 */

import { describe, expect, it } from 'vitest';
import { formatVotes } from '@/mcp-server/tools/format-helpers.js';

const render = (result: Record<string, unknown>) => formatVotes(result)[0].text;

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

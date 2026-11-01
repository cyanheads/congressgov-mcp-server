/**
 * @fileoverview Tests for congressgov_senate_nominations tool.
 * @module tests/mcp-server/tools/definitions/senate-nominations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/congress-api/congress-api-service.js', () => ({
  getCongressApi: vi.fn(),
  initCongressApi: vi.fn(),
}));

import {
  citedRollVote,
  senateNominationsTool,
} from '@/mcp-server/tools/definitions/senate-nominations.tool.js';
import { getCongressApi } from '@/services/congress-api/congress-api-service.js';

/** Join a formatter's blocks into the single string a content-only client sees. */
function joinText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((b) => b.text ?? '').join('\n');
}

/** Real `latestAction` / `S05310` text from /nomination/119/730-2 (vote 225, 119th Congress, session 2). */
const CONFIRMED_225 = {
  actionDate: '2026-08-07',
  text: 'Confirmed by the Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 225.',
};
const POINTER_225 = { chamber: 'senate', congress: 119, session: 2, voteNumber: 225 };
const POINTER_LINE_225 =
  '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=119, session=2, voteNumber=225';

describe('senateNominationsTool', () => {
  const mockApi = {
    listNominations: vi.fn(),
    getNomination: vi.fn(),
    getNominee: vi.fn(),
    getNominationSubResource: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCongressApi).mockReturnValue(mockApi as any);
  });

  it('lists nominations by congress', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    mockApi.listNominations.mockResolvedValue({
      data: [{ nominationNumber: '1064' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({ operation: 'list', congress: 118 });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('gets a specific nomination', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    mockApi.getNomination.mockResolvedValue({ nomination: { description: 'Judge' } });
    const input = senateNominationsTool.input.parse({
      operation: 'get',
      congress: 118,
      nominationNumber: '1064',
    });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.nomination).toEqual({ description: 'Judge' });
  });

  it('throws when detail operation is missing nominationNumber', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    const input = senateNominationsTool.input.parse({ operation: 'get', congress: 118 });
    await expect(senateNominationsTool.handler(input, ctx)).rejects.toThrow(/nominationNumber/);
  });

  it('gets nominees with ordinal', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    mockApi.getNominee.mockResolvedValue({
      data: [{ name: 'Doe' }],
      pagination: { count: 1, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({
      operation: 'nominees',
      congress: 118,
      nominationNumber: '1064',
      ordinal: 1,
    });
    const result = await senateNominationsTool.handler(input, ctx);
    expect(result.data).toHaveLength(1);
  });

  it('throws when nominees is missing ordinal', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    const input = senateNominationsTool.input.parse({
      operation: 'nominees',
      congress: 118,
      nominationNumber: '1064',
    });
    await expect(senateNominationsTool.handler(input, ctx)).rejects.toThrow(/ordinal/);
  });

  it('fetches nomination sub-resources (actions, committees, hearings)', async () => {
    const ctx = createMockContext({ errors: senateNominationsTool.errors });
    mockApi.getNominationSubResource.mockResolvedValue({
      data: [],
      pagination: { count: 0, nextOffset: null },
    });
    const input = senateNominationsTool.input.parse({
      operation: 'actions',
      congress: 118,
      nominationNumber: '1064',
    });
    await senateNominationsTool.handler(input, ctx);
    expect(mockApi.getNominationSubResource).toHaveBeenCalledWith(
      expect.objectContaining({ subResource: 'actions' }),
      ctx,
    );
  });

  describe('Senate roll vote pointers (issue #62)', () => {
    /** Trimmed from /nomination/119/730-2/actions: the confirmation, cloture, and three rows citing no vote. */
    const pn730_2Actions = [
      { actionCode: 'S05310', ...CONFIRMED_225, type: 'Floor' },
      {
        actionCode: 'S05220',
        actionDate: '2026-08-07',
        text: 'Considered by Senate.',
        type: 'Floor',
      },
      {
        actionCode: 'S05240',
        actionDate: '2026-08-05',
        text: 'Cloture invoked in Senate by Yea-Nay Vote. 50 - 44. Record Vote Number: 221.',
        type: 'Floor',
      },
      {
        actionCode: 'S05205',
        actionDate: '2026-08-03',
        text: 'Motion to proceed to executive session to consideration of nomination pursuant to S. Res. 817, 119th Congress agreed to in Senate by Voice Vote.',
        type: 'Floor',
      },
      {
        actionCode: 'S05120',
        actionDate: '2026-01-13',
        committees: [
          {
            name: 'Homeland Security and Governmental Affairs Committee',
            systemCode: 'ssga00',
            url: 'https://api.congress.gov/v3/committee/senate/ssga00?format=json',
          },
        ],
        text: 'Received in the Senate and referred to the Committee on Homeland Security and Governmental Affairs.',
        type: 'IntroReferral',
      },
    ];

    async function run(raw: Record<string, unknown>) {
      const ctx = createMockContext({ errors: senateNominationsTool.errors });
      const input = senateNominationsTool.input.parse(raw);
      const result = await senateNominationsTool.handler(input, ctx);
      /** The framework parses the handler result against the declared output before it ships. */
      senateNominationsTool.output.parse(result);
      return result as {
        data?: Array<Record<string, unknown>>;
        nomination?: Record<string, unknown>;
      };
    }

    it('points get at the vote its latest action cites, on both surfaces', async () => {
      mockApi.getNomination.mockResolvedValue({
        nomination: {
          citation: 'PN730-2',
          congress: 119,
          number: 730,
          partNumber: '02',
          latestAction: { ...CONFIRMED_225 },
        },
      });
      const result = await run({ operation: 'get', congress: 119, nominationNumber: '730-2' });
      expect(result.nomination?.latestAction).toEqual({ ...CONFIRMED_225, rollVote: POINTER_225 });
      expect(joinText(senateNominationsTool.format!(result as never))).toContain(
        `**Latest Action:** 2026-08-07 — ${CONFIRMED_225.text}\n${POINTER_LINE_225}`,
      );
    });

    it('leaves a multi-part parent with no latest action as it arrived', async () => {
      const parent = { citation: 'PN730', congress: 119, number: 730, partNumber: '00' };
      mockApi.getNomination.mockResolvedValueOnce({ nomination: parent });
      expect(
        (await run({ operation: 'get', congress: 119, nominationNumber: '730' })).nomination,
      ).toBe(parent);
      const nullAction = { ...parent, latestAction: null };
      mockApi.getNomination.mockResolvedValueOnce({ nomination: nullAction });
      expect(
        (await run({ operation: 'get', congress: 119, nominationNumber: '730' })).nomination,
      ).toBe(nullAction);
    });

    it('points every actions row citing its own vote, cloture included, and no other row', async () => {
      mockApi.getNominationSubResource.mockResolvedValue({
        data: pn730_2Actions,
        pagination: { count: 15, nextOffset: 5 },
      });
      const result = await run({
        operation: 'actions',
        congress: 119,
        nominationNumber: '730-2',
        limit: 5,
      });
      expect(result.data?.map((row) => row.rollVote)).toEqual([
        POINTER_225,
        undefined,
        { ...POINTER_225, voteNumber: 221 },
        undefined,
        undefined,
      ]);
      expect(result.data?.[1]).toBe(pn730_2Actions[1]);
      expect(result.data?.[0]).toEqual({ ...pn730_2Actions[0], rollVote: POINTER_225 });
      const content = joinText(senateNominationsTool.format!(result as never));
      expect(content).toContain(POINTER_LINE_225);
      expect(content).toContain(
        '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=119, session=2, voteNumber=221',
      );
    });

    it('skips back-references to another action’s vote (118th PN157)', async () => {
      /** Trimmed from /nomination/118/157/actions. */
      mockApi.getNominationSubResource.mockResolvedValue({
        data: [
          {
            actionCode: 'S05240',
            actionDate: '2024-03-21',
            text: 'Upon reconsideration, cloture invoked in Senate by Yea-Nay Vote. 50 - 49. Record Vote Number: 99.',
            type: 'Floor',
          },
          {
            actionCode: 'S05360',
            actionDate: '2024-03-21',
            text: 'Motion by Senator Schumer to reconsider the vote (Record Vote No. 318), by which cloture was not invoked on the nomination, agreed to in Senate by Unanimous Consent.',
            type: 'Floor',
          },
          {
            actionCode: 'S05360',
            actionDate: '2023-11-28',
            text: 'Motion by Senator Schumer to reconsider the vote (Roll Call Vote No. 318) by which cloture was not invoked on the nomination entered in Senate.',
            type: 'Floor',
          },
          {
            actionCode: 'S05240',
            actionDate: '2023-11-28',
            text: 'Cloture not invoked in Senate by Yea-Nay Vote. 44 - 51. Record Vote Number: 318.',
            type: 'Floor',
          },
        ],
        pagination: { count: 17, nextOffset: null },
      });
      const result = await run({ operation: 'actions', congress: 118, nominationNumber: '157' });
      expect(result.data?.map((row) => row.rollVote)).toEqual([
        { chamber: 'senate', congress: 118, session: 2, voteNumber: 99 },
        undefined,
        undefined,
        { chamber: 'senate', congress: 118, session: 1, voteNumber: 318 },
      ]);
    });

    it('points list rows at the vote their latest action cites', async () => {
      const voiceVote = {
        citation: 'PN11-21',
        latestAction: {
          actionDate: '2025-10-07',
          text: 'Confirmed by the Senate by Voice Vote.',
        },
      };
      const noAction = { citation: 'PN12' };
      const nullAction = { citation: 'PN730', latestAction: null };
      mockApi.listNominations.mockResolvedValue({
        data: [
          { citation: 'PN730-2', latestAction: { ...CONFIRMED_225 } },
          voiceVote,
          noAction,
          nullAction,
        ],
        pagination: { count: 4, nextOffset: null },
      });
      const result = await run({ operation: 'list', congress: 119 });
      expect(result.data?.[0]?.latestAction).toEqual({ ...CONFIRMED_225, rollVote: POINTER_225 });
      expect(result.data?.slice(1)).toEqual([voiceVote, noAction, nullAction]);
      expect(result.data?.[1]).toBe(voiceVote);
      expect(joinText(senateNominationsTool.format!(result as never))).toContain(POINTER_LINE_225);
    });

    it('points only actions rows, not committees, hearings, or nominees', async () => {
      const row = { name: 'Judiciary Committee', systemCode: 'ssju00', ...CONFIRMED_225 };
      mockApi.getNominationSubResource.mockResolvedValue({
        data: [row],
        pagination: { count: 1, nextOffset: null },
      });
      const result = await run({
        operation: 'committees',
        congress: 119,
        nominationNumber: '730-2',
      });
      expect(result.data?.[0]).toBe(row);
    });
  });
});

describe('citedRollVote', () => {
  /** One in-range date for every phrasing, so the table exercises the citation grammar alone. */
  const at = (text: string) => citedRollVote({ actionDate: '1998-04-27', text }, 105);

  it.each([
    ['Confirmed by the Senate by Yea-Nay Vote. 51 - 47. Record Vote Number: 225.', 225],
    ['Nomination disapproved by the Senate by Yea-Nay. 47-53. Record Vote No: 20.', 20],
    ['Confirmed by the Senate by Yea-Nay Vote. 99-0. Record Vote No: 274', 274],
    ['Confirmed by the Senate by Yea-Nay Vote. 92-0. Record Vote No: 104 EX.', 104],
    ['Confirmed by the Senate by Yea-Nay Vote. 57-41. Record Vote No: 309EX.', 309],
    ['Confirmed by the Senate by Yea-Nay Vote. 96-0. Record Vote No: EX. 3.', 3],
    ['Confirmed by the Senate by Yea-Nay Vote. 71-0. Record Vote No: 205, EX.', 205],
    ['Confirmed by the Senate by Yea-Nay Vote. 90-3. Record Vote No: 290 .', 290],
    ['Considered by Senate. By Yea-Nay Vote. 99-0. Record Vote No: 3 EX.', 3],
    /** 115th PN25: the back-reference names 36, the action's own vote is 37. */
    [
      'Motion by Senator McConnell to reconsider the vote by which Rex. W. Tillerson, of Texas, was confirmed as Secretary of State (Record Vote No. 36) tabled in Senate by Yea-Nay Vote. 55 - 43. Record Vote Number: 37.',
      37,
    ],
  ])('%s → %i', (text, voteNumber) => {
    expect(at(text)).toEqual({ chamber: 'senate', congress: 105, session: 2, voteNumber });
  });

  it.each([
    'Motion by Senator Schumer to reconsider the vote (Roll Call Vote No. 318) by which cloture was not invoked on the nomination entered in Senate.',
    'Motion to proceed to consideration of the motion to reconsider the vote (Record Vote No. 318), by which cloture was not invoked on the nomination, agreed to in Senate by Unanimous Consent.',
    'Confirmed by the Senate by Voice Vote.',
    'By unanimous consent agreement, debate and vote 1/3/2018.',
    'Record Vote Number: 0.',
    'Record Vote Number: 99999999999999999999.',
  ])('points nowhere for %j', (text) => {
    expect(at(text)).toBeUndefined();
  });

  it('derives the session from the action date, January tail included (115th PN1098)', () => {
    expect(
      citedRollVote(
        {
          actionDate: '2018-01-03',
          text: 'Confirmed by the Senate by Yea-Nay Vote. 81 - 7. Record Vote Number: 1.',
        },
        115,
      ),
    ).toEqual({ chamber: 'senate', congress: 115, session: 2, voteNumber: 1 });
  });

  it('points nowhere for a date outside the congress', () => {
    expect(citedRollVote({ ...CONFIRMED_225, actionDate: '2027-01-04' }, 119)).toBeUndefined();
  });

  it('points nowhere below the 101st Congress, where the Senate feed starts (100th PN722)', () => {
    expect(
      citedRollVote(
        {
          actionDate: '1988-02-03',
          text: 'Confirmed by the Senate by Yea-Nay Vote. 97-0. Record Vote No: 16.',
        },
        100,
      ),
    ).toBeUndefined();
    expect(
      citedRollVote(
        {
          actionDate: '1989-03-09',
          text: 'Nomination disapproved by the Senate by Yea-Nay. 47-53. Record Vote No: 20.',
        },
        101,
      ),
    ).toEqual({ chamber: 'senate', congress: 101, session: 1, voteNumber: 20 });
  });

  it.each([
    ['a null action', null],
    ['an action with no date', { text: CONFIRMED_225.text }],
    ['an action with no text', { actionDate: CONFIRMED_225.actionDate }],
    ['a non-object action', 'Record Vote Number: 225.'],
  ])('points nowhere for %s', (_label, action) => {
    expect(citedRollVote(action, 119)).toBeUndefined();
  });
});

describe('citation scan timing', () => {
  /** Least thread CPU time per call, in microseconds, over `rounds` batches of `batch` calls. */
  function leastCpuMicrosPerCall(fn: () => void, batch: number, rounds = 5): number {
    let least = Number.POSITIVE_INFINITY;
    for (let round = 0; round < rounds; round++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < batch; i++) fn();
      const used = process.threadCpuUsage(start);
      least = Math.min(least, (used.user + used.system) / batch);
    }
    return least;
  }

  /** Doubles from 5k to `maxChars`, checking the absolute bound at each size before the next. */
  function timeShape(build: (chars: number) => string, maxChars: number): number[] {
    const perCall: number[] = [];
    for (let chars = 5_000; chars <= maxChars; chars *= 2) {
      const text = build(chars);
      /** ~5M characters per batch, so even the cheapest shape's batch spans far more than the timer's 1 µs resolution. */
      const micros = leastCpuMicrosPerCall(
        () => citedRollVote({ actionDate: '2026-08-07', text }, 119),
        Math.max(1, Math.round(5_120_000 / chars)),
      );
      /** 0.1 µs per character: a linear scan runs well inside it, a quadratic one at 80k far outside. */
      expect(micros, `${chars} chars`).toBeLessThan(chars * 0.1);
      perCall.push(micros);
    }
    return perCall;
  }

  const ratio = (perCall: number[]) => (perCall.at(-1) as number) / (perCall[0] as number);

  it('stays linear on a long digit run across a 64× span', () => {
    const perCall = timeShape((chars) => `Record Vote Number: ${'9'.repeat(chars)}`, 320_000);
    expect(perCall).toHaveLength(7);
    expect(ratio(perCall)).toBeLessThan(256);
  });

  it.each([
    ['a repeated opener with no number', (chars: number) => 'Record Vote No: '.repeat(chars / 16)],
    [
      'a repeated opener with an EX. prefix',
      (chars: number) => 'Record Vote No: EX. '.repeat(chars / 20),
    ],
    ['one long line ending in a break', (chars: number) => `${'§1 x'.repeat(chars / 4)}\ny`],
    ['breaks throughout', (chars: number) => '  \r\n'.repeat(chars / 4)],
  ])('stays linear on %s', (_label, build) => {
    const perCall = timeShape(build, 80_000);
    expect(perCall).toHaveLength(5);
    expect(ratio(perCall)).toBeLessThan(64);
  });
});

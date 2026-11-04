/**
 * @fileoverview The `congressgov_roll_votes` arguments for a recorded vote, built
 * only for the chambers and congresses that tool serves.
 * @module mcp-server/tools/roll-vote-pointer
 */

import { z } from '@cyanheads/mcp-ts-core';
import { SENATE_VOTE_COVERAGE, SENATE_VOTE_FIRST_CONGRESS } from '@/services/senate-lis/parse.js';
import { congressFirstYear, ordinal } from '@/utils/congress-calendar.js';

/**
 * First congress Congress.gov's `house-vote` data covers: `/house-vote/114/1`
 * reports `count: 0` and `/house-vote/115/1` lists 710 votes (as of 2026-11-03).
 */
export const HOUSE_VOTE_FIRST_CONGRESS = 115;

/** Where House vote coverage starts, as a clause for notices and descriptions. */
export const HOUSE_VOTE_COVERAGE = `Congress.gov publishes House roll call votes from the ${ordinal(HOUSE_VOTE_FIRST_CONGRESS)} Congress (${congressFirstYear(HOUSE_VOTE_FIRST_CONGRESS)}) onward`;

export type RollVoteChamber = 'house' | 'senate';

/** Arguments for `congressgov_roll_votes` that retrieve one roll call vote. */
export interface RollVotePointer<C extends RollVoteChamber = RollVoteChamber> {
  chamber: C;
  congress: number;
  session: number;
  voteNumber: number;
}

/**
 * The `congressgov_roll_votes` arguments for a vote, or `undefined` when that
 * tool has no data for the vote: a House vote before the 115th Congress, a
 * Senate vote before the 101st, or a session or vote number it doesn't accept.
 */
export function rollVotePointer<C extends RollVoteChamber>(
  chamber: C,
  congress: number,
  session: number,
  voteNumber: number,
): RollVotePointer<C> | undefined {
  const firstCongress =
    chamber === 'house' ? HOUSE_VOTE_FIRST_CONGRESS : SENATE_VOTE_FIRST_CONGRESS;
  if (congress < firstCongress) return;
  if (session !== 1 && session !== 2) return;
  if (!Number.isSafeInteger(voteNumber) || voteNumber < 1) return;
  return { chamber, congress, session, voteNumber };
}

/**
 * The pointer for the vote a Congress.gov bill action records in `recordedVotes`
 * — each entry `{chamber: 'House' | 'Senate', congress, sessionNumber, rollNumber}`
 * — or `undefined` when the action records no vote, records several, or records
 * one `congressgov_roll_votes` doesn't serve. The entry's own session is used:
 * Congress.gov already places a January 1–3 vote in the prior year's session.
 */
export function recordedRollVote(recordedVotes: unknown): RollVotePointer | undefined {
  if (!Array.isArray(recordedVotes) || recordedVotes.length !== 1) return;
  const [entry] = recordedVotes;
  if (!entry || typeof entry !== 'object') return;
  const { chamber, congress, sessionNumber, rollNumber } = entry as Record<string, unknown>;
  const lowered = typeof chamber === 'string' ? chamber.toLowerCase() : undefined;
  if (lowered !== 'house' && lowered !== 'senate') return;
  if (
    typeof congress !== 'number' ||
    typeof sessionNumber !== 'number' ||
    typeof rollNumber !== 'number'
  ) {
    return;
  }
  return rollVotePointer(lowered, congress, sessionNumber, rollNumber);
}

/** `rollVote` on a bill action: the pointer `recordedRollVote` builds, in either chamber. */
export const recordedRollVoteSchema = z
  .object({
    chamber: z
      .enum(['house', 'senate'])
      .describe(
        "Chamber the vote was cast in. Pass it: congressgov_roll_votes defaults to 'house', and roll call numbers are specific to one chamber.",
      ),
    congress: z.number().int().positive().describe('Congress the vote was cast in.'),
    session: z
      .number()
      .int()
      .min(1)
      .max(2)
      .describe('Session the vote was cast in (1 or 2); roll call numbers restart each session.'),
    voteNumber: z.number().int().positive().describe('Roll call vote number.'),
  })
  .describe(
    `Arguments for congressgov_roll_votes that retrieve the roll call vote this action records — its one recordedVotes entry. Absent when the action records no vote or several, and for a vote that tool has no data for: ${HOUSE_VOTE_COVERAGE}, and ${SENATE_VOTE_COVERAGE}.`,
  );

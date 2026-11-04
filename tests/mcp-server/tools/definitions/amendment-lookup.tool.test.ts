/**
 * @fileoverview Tests for congressgov_amendment_lookup, run through the real
 * CongressApiService and CongressDocumentsService against a fetch stub that
 * serves trimmed Congress.gov captures (2026-11-03). Covers the identifier
 * chain from the three tools that emit amendment IDs, every operation on both
 * client surfaces, the roll vote pointer on actions, the `content` window and
 * its failure modes, and the list boundaries.
 * @module tests/mcp-server/tools/definitions/amendment-lookup.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    apiKey: 'test-api-key',
    baseUrl: 'https://api.congress.gov/v3',
  })),
}));

import { amendmentLookupTool } from '@/mcp-server/tools/definitions/amendment-lookup.tool.js';
import { formatBills, formatMembers, formatVotes } from '@/mcp-server/tools/format-helpers.js';
import { initCongressApi } from '@/services/congress-api/congress-api-service.js';
import { initCongressDocuments } from '@/services/congress-documents/congress-documents-service.js';

/** Join a formatter's blocks into the single string a content[]-only client sees. */
function joinText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks.map((b) => b.text ?? '').join('\n');
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function rendered(result: ContractResult): string {
  return joinText(result.content as Array<{ type: string; text?: string }>);
}

/**
 * Call the tool through the framework's contract runner: both surfaces, filled
 * recovery hints. Raw caller arguments deliberately include aliases, mixed-case
 * types, and invalid combinations, so they are not the parsed input type.
 */
function call(args: Record<string, unknown>): Promise<ContractResult> {
  return runToolContract(amendmentLookupTool, args as never);
}

// ── Captures (api.congress.gov v3 and www.congress.gov, 2026-11-03), trimmed ──

const ROY_LATEST_ACTION = {
  actionDate: '2023-07-14',
  actionTime: '10:44:04',
  text: 'On agreeing to the Roy amendment (A040) Agreed to by recorded vote: 217 - 216 (Roll no. 326).',
};

/** /bill/118/hr/2670/amendments — the HAMDT 255 row. */
const BILL_AMENDMENT_ROW = {
  congress: 118,
  description:
    "An amendment numbered 64 printed in House Report 118-142 to prohibit the DOD from carrying out the President's Administration climate change executive orders.",
  latestAction: ROY_LATEST_ACTION,
  number: '255',
  purpose:
    "Amendment prohibits the Department of Defense from carrying out the Administration's climate change executive orders.",
  type: 'HAMDT',
  updateDate: '2025-05-13T11:06:20Z',
  url: 'https://api.congress.gov/v3/amendment/118/hamdt/255?format=json',
};

/** /member/R000614/sponsored-legislation — the HAMDT 255 row: no type, the type only in `url`. */
const MEMBER_AMENDMENT_ROW = {
  amendmentNumber: '255',
  congress: 118,
  introducedDate: '2023-07-14',
  latestAction: ROY_LATEST_ACTION,
  type: null,
  url: 'https://api.congress.gov/v3/amendment/118/hamdt/255?format=json',
};

/** /house-vote/118/1/326 — the vote on HAMDT 255. */
const HOUSE_VOTE_326 = {
  amendmentAuthor: 'Roy of Texas Amendment No. 64',
  amendmentNumber: '255',
  amendmentType: 'HAMDT',
  congress: 118,
  identifier: 11812023326,
  legislationNumber: '2670',
  legislationType: 'HR',
  legislationUrl: 'https://www.congress.gov/amendment/118/house-amendment/255',
  result: 'Agreed to',
  rollCallNumber: 326,
  sessionNumber: 1,
  sourceDataURL: 'https://clerk.house.gov/evs/2023/roll326.xml',
  startDate: '2023-07-14T10:39:00-04:00',
  updateDate: '2025-08-01T18:18:41-04:00',
  voteQuestion: 'On Agreeing to the Amendment',
  voteType: 'Recorded Vote',
};

/** /amendment/118/hamdt/255 */
const HAMDT_255 = {
  actions: {
    count: 7,
    url: 'https://api.congress.gov/v3/amendment/118/hamdt/255/actions?format=json',
  },
  amendedBill: {
    congress: 118,
    number: '2670',
    originChamber: 'House',
    originChamberCode: 'H',
    title: 'National Defense Authorization Act for Fiscal Year 2024',
    type: 'HR',
    updateDateIncludingText: '2026-09-08',
    url: 'https://api.congress.gov/v3/bill/118/hr/2670?format=json',
  },
  chamber: 'House of Representatives',
  congress: 118,
  description: BILL_AMENDMENT_ROW.description,
  latestAction: {
    ...ROY_LATEST_ACTION,
    links: [{ name: 'Roll no. 326', url: 'https://www.congress.gov/votes/house/118-1/326' }],
  },
  number: '255',
  purpose: BILL_AMENDMENT_ROW.purpose,
  sponsors: [
    {
      bioguideId: 'R000614',
      district: 21,
      firstName: 'Chip',
      fullName: 'Rep. Roy, Chip [R-TX-21]',
      lastName: 'Roy',
      party: 'R',
      state: 'TX',
      url: 'https://api.congress.gov/v3/member/R000614?format=json',
    },
  ],
  submittedDate: '2023-07-14T04:00:00Z',
  textVersions: {
    count: 1,
    url: 'https://api.congress.gov/v3/amendment/118/hamdt/255/text?format=json',
  },
  type: 'HAMDT',
  updateDate: '2025-05-13T11:06:20Z',
};

/** /amendment/97/suamdt/7 — a sparse Senate unprinted amendment: no description, no cosponsors. */
const SUAMDT_7 = {
  actions: {
    count: 5,
    url: 'https://api.congress.gov/v3/amendment/97/suamdt/7/actions?format=json',
  },
  amendedBill: {
    congress: 97,
    number: '38',
    originChamber: 'Senate',
    originChamberCode: 'S',
    title:
      'A joint resolution to provide for designation of the first Friday of March as "Teacher Day, United States of America".',
    type: 'SJRES',
    updateDateIncludingText: '2026-08-10',
    url: 'https://api.congress.gov/v3/bill/97/sjres/38?format=json',
  },
  chamber: 'Senate',
  congress: 97,
  latestAction: { actionDate: '1981-03-05', text: 'Amendment agreed to in Senate by Voice Vote. ' },
  number: '7',
  proposedDate: '1981-03-05T05:00:00Z',
  purpose: 'To amend the preamble.',
  sponsors: [
    {
      bioguideId: 'B000063',
      firstName: 'HOWARD',
      fullName: 'Sen. Baker, Howard H., Jr. [R-TN]',
      lastName: 'BAKER',
      middleName: 'HENRY',
      party: 'R',
      state: 'TN',
      url: 'https://api.congress.gov/v3/member/B000063?format=json',
    },
  ],
  submittedDate: '1981-03-05T05:00:00Z',
  textVersions: {
    count: 1,
    url: 'https://api.congress.gov/v3/amendment/97/suamdt/7/text?format=json',
  },
  type: 'SUAMDT',
  updateDate: '2021-08-13T20:30:58Z',
};

/** /amendment/117/samdt/2564 — an amendment to an amendment (SAMDT 2137). */
const SAMDT_2564 = {
  amendedAmendment: {
    congress: 117,
    number: '2137',
    purpose: 'In the nature of a substitute.',
    type: 'SAMDT',
    updateDate: '2022-02-08T17:27:59Z',
    url: 'https://api.congress.gov/v3/amendment/117/samdt/2137?format=json',
  },
  chamber: 'Senate',
  congress: 117,
  number: '2564',
  purpose: 'To improve provisions relating to appropriations for the Corps of Engineers.',
  type: 'SAMDT',
};

/** /amendment/117/samdt/2137 — trimmed to identity. */
const SAMDT_2137 = {
  chamber: 'Senate',
  congress: 117,
  number: '2137',
  purpose: 'In the nature of a substitute.',
  sponsors: [{ bioguideId: 'S001191', fullName: 'Sen. Sinema, Kyrsten [D-AZ]' }],
  type: 'SAMDT',
};

/** /amendment/118/hamdt/255/actions — the roll call row, a row with none, and a second roll call row. */
const HOUSE_ROLL_ACTION = {
  actionCode: 'H32111',
  actionDate: '2023-07-14',
  actionTime: '10:44:04',
  recordedVotes: [
    {
      chamber: 'House',
      congress: 118,
      date: '2023-07-14T14:44:04Z',
      rollNumber: 326,
      sessionNumber: 1,
      url: 'https://clerk.house.gov/evs/2023/roll326.xml',
    },
  ],
  sourceSystem: { code: 2, name: 'House floor actions' },
  text: 'On agreeing to the Roy amendment (A040) Agreed to by recorded vote: 217 - 216 (Roll no. 326).',
  type: 'Floor',
};
const HOUSE_OFFERED_ACTION = {
  actionCode: 'H3A100',
  actionDate: '2023-07-14',
  actionTime: '09:30:06',
  sourceSystem: { code: 2, name: 'House floor actions' },
  text: 'Amendment (A040) offered by Mr. Roy. (consideration: CR H3582-3584, H3598; text: CR H3582-3583)',
  type: 'Floor',
};
const HOUSE_LOC_ROLL_ACTION = {
  actionCode: '75000',
  actionDate: '2023-07-14',
  actionTime: '10:44:04',
  recordedVotes: HOUSE_ROLL_ACTION.recordedVotes,
  sourceSystem: { code: 9, name: 'Library of Congress' },
  text: 'Roll call votes on amendments in House',
  type: 'Floor',
};

/** /amendment/117/samdt/2137/actions — votes 312 and 309, and a row recording none. */
const SENATE_312_ACTION = {
  actionDate: '2021-08-08',
  recordedVotes: [
    {
      chamber: 'Senate',
      congress: 117,
      date: '2021-08-09T00:45:48Z',
      rollNumber: 312,
      sessionNumber: 1,
      url: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1171/vote_117_1_00312.xml',
    },
  ],
  sourceSystem: { code: 0, name: 'Senate' },
  text: 'Amendment SA 2137 agreed to in Senate by Yea-Nay Vote. 69 - 28. Record Vote Number: 312. ',
  type: 'Floor',
};
const SENATE_CONSIDERED_ACTION = {
  actionDate: '2021-08-08',
  sourceSystem: { code: 0, name: 'Senate' },
  text: 'Considered by Senate. (consideration: CR S6034, S6056-6057)',
  type: 'Floor',
};
const SENATE_309_ACTION = {
  actionDate: '2021-08-07',
  recordedVotes: [
    {
      chamber: 'Senate',
      congress: 117,
      date: '2021-08-07T17:14:46Z',
      rollNumber: 309,
      sessionNumber: 1,
      url: 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1171/vote_117_1_00309.xml',
    },
  ],
  sourceSystem: { code: 0, name: 'Senate' },
  text: 'Cloture on amendment SA 2137 invoked in Senate by Yea-Nay Vote. 67 - 27. Record Vote Number: 309. (CR S5997)',
  type: 'Floor',
};

/** /amendment/114/hamdt/5/actions — a House roll call before Congress.gov's House vote data begins. */
const HOUSE_114_ROLL_ACTION = {
  actionCode: 'H32111',
  actionDate: '2015-01-13',
  actionTime: '17:07:14',
  recordedVotes: [
    {
      chamber: 'House',
      congress: 114,
      date: '2015-01-13T22:07:14Z',
      rollNumber: 26,
      sessionNumber: 1,
      url: 'https://clerk.house.gov/evs/2015/roll026.xml',
    },
  ],
  sourceSystem: { code: 2, name: 'House floor actions' },
  text: 'On agreeing to the Connolly amendment (A004) Failed by recorded vote: 178 - 248 (Roll no. 26). ',
  type: 'Floor',
};

/** /amendment/117/samdt/2137/cosponsors — the first of 9. */
const PORTMAN_COSPONSOR = {
  bioguideId: 'P000449',
  firstName: 'Rob',
  fullName: 'Sen. Portman, Rob [R-OH]',
  isOriginalCosponsor: true,
  lastName: 'Portman',
  party: 'R',
  sponsorshipDate: '2021-08-01',
  state: 'OH',
  url: 'https://api.congress.gov/v3/member/P000449?format=json',
};

/** /amendment/117/samdt/2137/amendments?offset=505&limit=2 — the last two of 507. */
const AMENDMENTS_TO_2137_TAIL = [
  {
    congress: 117,
    latestAction: {
      actionDate: '2021-08-02',
      text: 'Amendment SA 2133, under the order of 8/2/2021, having achieved 60 votes in the affirmative, was agreed to in Senate by Yea-Nay Vote. 90 - 7. Record Vote Number: 291. ',
    },
    number: '2133',
    purpose:
      'To amend the Indian Health Care Improvement Act to expand the funding authority for renovating, constructing, and expanding certain facilities.',
    type: 'SAMDT',
    updateDate: '2021-08-06T11:01:30Z',
    url: 'https://api.congress.gov/v3/amendment/117/samdt/2133?format=json',
  },
  {
    congress: 117,
    latestAction: {
      actionDate: '2021-08-08',
      text: 'Amendment SA 2131 agreed to in Senate by Voice Vote. ',
    },
    number: '2131',
    purpose: 'To strike a definition.',
    type: 'SAMDT',
    updateDate: '2021-08-11T01:48:47Z',
    url: 'https://api.congress.gov/v3/amendment/117/samdt/2131?format=json',
  },
];

/** /amendment/118/hamdt?sort=updateDate+desc — the first row of 1235. */
const HAMDT_549_ROW = {
  congress: 118,
  description:
    'An amendment numbered 66 printed in Part A of House Report 118-261 to prohibit funds for the United States Board on Geographic Names.',
  latestAction: {
    actionDate: '2023-11-02',
    actionTime: '17:26:27',
    text: 'On agreeing to the Harshbarger amendment (A019) Failed by recorded vote: 177 - 246 (Roll no. 572).',
  },
  number: '549',
  type: 'HAMDT',
  updateDate: '2026-09-16T16:27:38Z',
  url: 'https://api.congress.gov/v3/amendment/118/hamdt/549?format=json',
};

const SAMDT_2137_HTML =
  'https://www.congress.gov/117/crec/2021/08/01/167/136/modified/CREC-2021-08-01-pt1-PgS5255.htm';
const SAMDT_2137_PDF =
  'https://www.congress.gov/117/crec/2021/08/01/167/136/CREC-2021-08-01-pt1-PgS5255.pdf';

/** /amendment/110/samdt/4199/text — the one sampled amendment with two text versions. */
const SAMDT_4199_VERSIONS = [
  {
    date: '2008-03-14T00:55:21Z',
    formats: [
      {
        type: 'HTML',
        url: 'https://www.congress.gov/110/crec/2008/03/13/154/43/modified/CREC-2008-03-13-pt1-PgS2062.htm',
      },
      {
        type: 'PDF',
        url: 'https://www.congress.gov/110/crec/2008/03/13/154/43/CREC-2008-03-13-pt1-PgS2062.pdf',
      },
    ],
    type: 'Proposed',
  },
  {
    date: '2008-03-12T04:00:00Z',
    formats: [
      {
        type: 'HTML',
        url: 'https://www.congress.gov/110/crec/2008/03/12/154/42/modified/CREC-2008-03-12-pt1-PgS2014.htm',
      },
      {
        type: 'PDF',
        url: 'https://www.congress.gov/110/crec/2008/03/12/154/42/CREC-2008-03-12-pt1-PgS2014.pdf',
      },
    ],
    type: 'Submitted',
  },
];

/**
 * The head of the SAMDT 2137 Congressional Record page (3,086,081 bytes), cut
 * after the short-title line and closed the way the page closes: GPO `<pre>`
 * print output with an inline anchor and `&#x27;` character references.
 */
const SAMDT_2137_PAGE =
  "<pre>\n\n\n[Pages S5255-S5528]\nFrom the Congressional Record Online through the Government Publishing Office [<a href='https://www.gpo.gov'>www.gpo.gov</a>]\n\n  SA 2137. Mr. SCHUMER (for Ms. Sinema (for herself, Mr. Portman, Mr. \nManchin, Mr. Cassidy, Mrs. Shaheen, Ms. Collins, Mr. Tester, Ms. \nMurkowski, Mr. Warner, and Mr. Romney)) proposed an amendment to the \nbill H.R. 3684, to authorize funds for Federal-aid highways, highway \nsafety programs, and transit programs, and for other purposes; as \nfollows:\n\n        Strike all after the enacting clause and insert the \n     following:\n\n     SECTION 1. SHORT TITLE; TABLE OF CONTENTS.\n\n       (a) Short Title.--This Act may be cited as the \n     ``Infrastructure Investment and Jobs Act&#x27;&#x27;.\n\n                          ____________________\n\n\n\n</pre>";

/**
 * That page's text, derived independently (Python: strip tags, `html.unescape`,
 * trim) — the GPO layout, indentation included, kept verbatim.
 */
const SAMDT_2137_TEXT =
  "[Pages S5255-S5528]\nFrom the Congressional Record Online through the Government Publishing Office [www.gpo.gov]\n\n  SA 2137. Mr. SCHUMER (for Ms. Sinema (for herself, Mr. Portman, Mr. \nManchin, Mr. Cassidy, Mrs. Shaheen, Ms. Collins, Mr. Tester, Ms. \nMurkowski, Mr. Warner, and Mr. Romney)) proposed an amendment to the \nbill H.R. 3684, to authorize funds for Federal-aid highways, highway \nsafety programs, and transit programs, and for other purposes; as \nfollows:\n\n        Strike all after the enacting clause and insert the \n     following:\n\n     SECTION 1. SHORT TITLE; TABLE OF CONTENTS.\n\n       (a) Short Title.--This Act may be cited as the \n     ``Infrastructure Investment and Jobs Act''.\n\n                          ____________________";

// ── The fetch boundary ────────────────────────────────────────────────

type ApiReply = { status?: number; body: unknown };

/** api.congress.gov routes by pathname; a function route reads the request's query. */
const apiRoutes = new Map<string, ApiReply | ((url: URL) => ApiReply)>();
/** www.congress.gov documents by pathname. */
const documents = new Map<string, string>();
/** Every URL requested, in order. */
const requested: URL[] = [];

const JSON_HEADERS = { 'content-type': 'application/json' };

function fetchStub(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  requested.push(url);
  if (url.hostname === 'api.congress.gov') {
    const route = apiRoutes.get(url.pathname);
    /** Congress.gov answers a path it does not serve — an upper-case type among them — with this 404. */
    const reply = route
      ? typeof route === 'function'
        ? route(url)
        : route
      : { status: 404, body: { error: `Unknown resource: ${url.pathname.slice(4)}` } };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: JSON_HEADERS,
      }),
    );
  }
  if (url.hostname === 'www.congress.gov') {
    const body = documents.get(url.pathname);
    return Promise.resolve(
      body === undefined
        ? new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } })
        : new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
  }
  return Promise.reject(new Error(`Unexpected host ${url.hostname}`));
}

/** A sub-resource list that pages the way Congress.gov does: `count` is the whole list, `next` while rows remain. */
function pagedList(key: string, rows: unknown[]): (url: URL) => ApiReply {
  return (url) => {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const page = rows.slice(offset, offset + limit);
    return {
      body: {
        [key]: page,
        pagination: {
          count: rows.length,
          ...(offset + page.length < rows.length
            ? { next: 'https://api.congress.gov/v3/next' }
            : {}),
        },
      },
    };
  };
}

function apiRequests(): URL[] {
  return requested.filter((url) => url.hostname === 'api.congress.gov');
}

function documentRequests(): URL[] {
  return requested.filter((url) => url.hostname === 'www.congress.gov');
}

beforeEach(() => {
  apiRoutes.clear();
  documents.clear();
  requested.length = 0;
  vi.stubGlobal('fetch', vi.fn(fetchStub));
  initCongressApi();
  initCongressDocuments();

  apiRoutes.set('/v3/amendment/118/hamdt/255', { body: { amendment: HAMDT_255 } });
  apiRoutes.set('/v3/amendment/97/suamdt/7', { body: { amendment: SUAMDT_7 } });
  apiRoutes.set('/v3/amendment/117/samdt/2564', { body: { amendment: SAMDT_2564 } });
  apiRoutes.set('/v3/amendment/117/samdt/2137', { body: { amendment: SAMDT_2137 } });
  apiRoutes.set('/v3/amendment/118/hamdt/999999', {
    status: 404,
    body: { error: 'No Amendment matches the given query.' },
  });
  apiRoutes.set(
    '/v3/amendment/118/hamdt/255/actions',
    pagedList('actions', [HOUSE_ROLL_ACTION, HOUSE_OFFERED_ACTION, HOUSE_LOC_ROLL_ACTION]),
  );
  apiRoutes.set(
    '/v3/amendment/117/samdt/2137/actions',
    pagedList('actions', [SENATE_312_ACTION, SENATE_CONSIDERED_ACTION, SENATE_309_ACTION]),
  );
  apiRoutes.set('/v3/amendment/114/hamdt/5/actions', pagedList('actions', [HOUSE_114_ROLL_ACTION]));
  apiRoutes.set('/v3/amendment/117/samdt/2137/cosponsors', (url) => ({
    body: {
      cosponsors: Number(url.searchParams.get('offset') ?? 0) === 0 ? [PORTMAN_COSPONSOR] : [],
      pagination: { count: 9, countIncludingWithdrawnCosponsors: 9, next: 'x' },
    },
  }));
  apiRoutes.set('/v3/amendment/118/hamdt/255/cosponsors', {
    body: { cosponsors: [], pagination: { count: 0, countIncludingWithdrawnCosponsors: 0 } },
  });
  apiRoutes.set('/v3/amendment/117/samdt/2137/amendments', (url) => {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return {
      body: {
        amendments: offset === 505 ? AMENDMENTS_TO_2137_TAIL : [],
        pagination: { count: 507 },
      },
    };
  });
  apiRoutes.set(
    '/v3/amendment/117/samdt/2137/text',
    pagedList('textVersions', [
      {
        date: '2021-08-01T04:00:00Z',
        formats: [
          { type: 'HTML', url: SAMDT_2137_HTML },
          { type: 'PDF', url: SAMDT_2137_PDF },
        ],
        type: 'Submitted',
      },
    ]),
  );
  apiRoutes.set(
    '/v3/amendment/110/samdt/4199/text',
    pagedList('textVersions', SAMDT_4199_VERSIONS),
  );
  apiRoutes.set(
    '/v3/amendment/97/suamdt/7/text',
    pagedList('textVersions', [{ date: '1981-03-05T05:00:00Z', formats: [], type: 'Submitted' }]),
  );
  apiRoutes.set('/v3/amendment/118/hamdt/205/text', pagedList('textVersions', []));
  apiRoutes.set('/v3/amendment/118/hamdt', (url) => ({
    body: {
      amendments: Number(url.searchParams.get('offset') ?? 0) >= 1235 ? [] : [HAMDT_549_ROW],
      pagination: { count: 1235, next: 'x' },
    },
  }));
  apiRoutes.set('/v3/amendment/118/suamdt', { body: { amendments: [], pagination: { count: 0 } } });
  apiRoutes.set('/v3/amendment/118', {
    body: { amendments: [HAMDT_549_ROW], pagination: { count: 4597, next: 'x' } },
  });

  documents.set(new URL(SAMDT_2137_HTML).pathname, SAMDT_2137_PAGE);
  documents.set(
    new URL(SAMDT_4199_VERSIONS[1]!.formats[0]!.url).pathname,
    '<pre>\n[Page S2014]\n  SA 4199. Mr. DORGAN submitted an amendment.\n</pre>',
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Characterization: the amendment identifiers the existing tools emit ─────

describe('amendment identifiers as the existing tools emit them', () => {
  it('bill_lookup amendments rows carry an upper-case type and a digit-string number on both surfaces', () => {
    const text = joinText(
      formatBills({ data: [BILL_AMENDMENT_ROW], pagination: { count: 45, nextOffset: 1 } }),
    );
    expect(BILL_AMENDMENT_ROW).toMatchObject({ type: 'HAMDT', number: '255', congress: 118 });
    expect(text).toContain('### 1. HAMDT 255:');
  });

  it('member_lookup amendment rows carry the number, with the type only in the url', () => {
    const text = joinText(
      formatMembers({ data: [MEMBER_AMENDMENT_ROW], pagination: { count: 234, nextOffset: 1 } }),
    );
    expect(text).toContain('### 1. House Amendment 255');
    expect(text).toContain('**URL:** https://api.congress.gov/v3/amendment/118/hamdt/255');
  });

  it('roll_votes House get and list carry amendmentType and amendmentNumber on both surfaces', () => {
    const detail = joinText(formatVotes({ vote: HOUSE_VOTE_326 }));
    expect(detail).toContain('**amendmentNumber:** 255');
    expect(detail).toContain('**amendmentType:** HAMDT');
    const list = joinText(
      formatVotes({ data: [HOUSE_VOTE_326], pagination: { count: 1, nextOffset: null } }),
    );
    expect(list).toContain('**amendmentNumber:** 255');
    expect(list).toContain('**amendmentType:** HAMDT');
  });
});

// ── The identifier chain ──────────────────────────────────────────────

describe('congressgov_amendment_lookup — resolving the identifiers other tools emit', () => {
  const memberType = /\/amendment\/\d+\/([a-z]+)\//.exec(MEMBER_AMENDMENT_ROW.url)?.[1];

  it.each([
    [
      'a bill_lookup amendments row, by its own keys',
      {
        congress: BILL_AMENDMENT_ROW.congress,
        type: BILL_AMENDMENT_ROW.type,
        number: BILL_AMENDMENT_ROW.number,
      },
    ],
    [
      'a roll_votes House vote',
      {
        congress: HOUSE_VOTE_326.congress,
        amendmentType: HOUSE_VOTE_326.amendmentType,
        amendmentNumber: HOUSE_VOTE_326.amendmentNumber,
      },
    ],
    [
      'a member_lookup amendment row, its type read from the url',
      {
        congress: MEMBER_AMENDMENT_ROW.congress,
        amendmentType: memberType,
        amendmentNumber: MEMBER_AMENDMENT_ROW.amendmentNumber,
      },
    ],
  ])('resolves %s to the one lower-case path Congress.gov serves', async (_name, identity) => {
    const result = await call({ operation: 'get', ...identity });
    expect(result.isError).not.toBe(true);
    expect(apiRequests().map((url) => url.pathname)).toEqual(['/v3/amendment/118/hamdt/255']);
    expect(result.structuredContent).toMatchObject({
      amendment: { sponsors: [{ bioguideId: 'R000614' }], amendedBill: { number: '2670' } },
    });
    expect(rendered(result)).toContain('# HAMDT 255');
  });

  it('walks from an amendment to the amendment it amends, past the first level', async () => {
    const child = await call({
      operation: 'get',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2564,
    });
    const parentRef = (child.structuredContent as { amendment: typeof SAMDT_2564 }).amendment
      .amendedAmendment;
    expect(rendered(child)).toContain('**amendedAmendment:**');
    expect(rendered(child)).toContain('In the nature of a substitute.');

    const parent = await call({
      operation: 'get',
      congress: parentRef.congress,
      type: parentRef.type,
      number: parentRef.number,
    });
    expect(parent.structuredContent).toMatchObject({ amendment: { number: '2137' } });
    expect(rendered(parent)).toContain('# SAMDT 2137');
    expect(apiRequests().map((url) => url.pathname)).toEqual([
      '/v3/amendment/117/samdt/2564',
      '/v3/amendment/117/samdt/2137',
    ]);
  });
});

// ── get ───────────────────────────────────────────────────────────────

describe("congressgov_amendment_lookup — 'get'", () => {
  it('carries the record on structuredContent and every field in content[]', async () => {
    const result = await call({
      operation: 'get',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 255,
    });
    expect(result.isError).not.toBe(true);
    expect(amendmentLookupTool.output.parse(result.structuredContent)).toMatchObject({
      amendment: HAMDT_255,
      effectiveQuery: 'HAMDT 255 in the 118th Congress',
      totalCount: 1,
    });
    const text = rendered(result);
    for (const value of [
      '# HAMDT 255',
      '**Congress:** 118 | **Chamber:** House of Representatives | **Submitted:** 2023-07-14T04:00:00Z | **Updated:** 2025-05-13T11:06:20Z',
      `**Purpose:** ${HAMDT_255.purpose}`,
      `**Description:** ${HAMDT_255.description}`,
      '**Latest Action:** 2023-07-14 — On agreeing to the Roy amendment (A040)',
      'Roll no. 326',
      'https://www.congress.gov/votes/house/118-1/326',
      'R000614',
      'Rep. Roy, Chip [R-TX-21]',
      'National Defense Authorization Act for Fiscal Year 2024',
      '**actions:** 7 available',
      '**textVersions:** 1 available',
    ]) {
      expect(text).toContain(value);
    }
  });

  it('renders a sparse record without inventing the fields it lacks', async () => {
    const result = await call({
      operation: 'get',
      congress: 97,
      amendmentType: 'SUAMDT',
      amendmentNumber: '7',
    });
    expect(amendmentLookupTool.output.parse(result.structuredContent)).toMatchObject({
      amendment: SUAMDT_7,
    });
    const text = rendered(result);
    expect(text).toContain('# SUAMDT 7');
    expect(text).toContain('**Proposed:** 1981-03-05T05:00:00Z');
    expect(text).toContain('**Purpose:** To amend the preamble.');
    expect(text).not.toContain('**Description:**');
    expect(text).not.toContain('cosponsors');
    expect(text).not.toContain('undefined');
  });

  it('fails not_found with the identifiers on both surfaces for an amendment Congress.gov does not hold', async () => {
    const result = await call({
      operation: 'get',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 999999,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'not_found',
          congress: 118,
          amendmentType: 'hamdt',
          amendmentNumber: 999999,
        },
      },
    });
    expect(rendered(result)).toContain('Amendment HAMDT 999999 not found in the 118th Congress.');
  });

  it.each([
    { operation: 'get', congress: 118, amendmentNumber: 255 },
    { operation: 'actions', congress: 118, amendmentType: 'hamdt' },
    { operation: 'content', congress: 118 },
  ])('requires amendmentType and amendmentNumber before any request: %j', async (args) => {
    const result = await call(args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError },
    });
    expect(rendered(result)).toContain('requires congress, amendmentType, and amendmentNumber');
    expect(requested).toHaveLength(0);
  });

  it('names the date bounds it ignored', async () => {
    const ctx = createMockContext({ errors: amendmentLookupTool.errors });
    const input = amendmentLookupTool.input.parse({
      operation: 'get',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 255,
      fromDateTime: '2023-01-01T00:00:00Z',
      toDateTime: '2023-12-31T00:00:00Z',
    });
    await amendmentLookupTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBe(
      "'get' does not use fromDateTime or toDateTime, so they were ignored.",
    );
    expect(apiRequests()[0]?.searchParams.has('fromDateTime')).toBe(false);
  });
});

// ── actions ───────────────────────────────────────────────────────────

describe("congressgov_amendment_lookup — 'actions' roll vote pointer", () => {
  async function actionsOf(congress: number, amendmentType: string, amendmentNumber: number) {
    const result = await call({ operation: 'actions', congress, amendmentType, amendmentNumber });
    expect(result.isError).not.toBe(true);
    const structured = amendmentLookupTool.output.parse(result.structuredContent) as {
      data: Array<Record<string, unknown>>;
    };
    return { rows: structured.data, text: rendered(result) };
  }

  it('points HAMDT 255 (118th) rows recording House roll 326 at it, and leaves the rest as served', async () => {
    const { rows, text } = await actionsOf(118, 'hamdt', 255);
    const pointer = { chamber: 'house', congress: 118, session: 1, voteNumber: 326 };
    expect(rows).toEqual([
      { ...HOUSE_ROLL_ACTION, rollVote: pointer },
      HOUSE_OFFERED_ACTION,
      { ...HOUSE_LOC_ROLL_ACTION, rollVote: pointer },
    ]);
    expect('rollVote' in rows[1]!).toBe(false);
    expect(
      text.match(
        /\*\*House Roll Vote:\*\* congressgov_roll_votes chamber=house, congress=118, session=1, voteNumber=326/g,
      ),
    ).toHaveLength(2);
    expect(text).toContain('https://clerk.house.gov/evs/2023/roll326.xml');
  });

  it('points SAMDT 2137 (117th) rows at Senate votes 312 and 309', async () => {
    const { rows, text } = await actionsOf(117, 'samdt', 2137);
    expect(rows.map((row) => row.rollVote)).toEqual([
      { chamber: 'senate', congress: 117, session: 1, voteNumber: 312 },
      undefined,
      { chamber: 'senate', congress: 117, session: 1, voteNumber: 309 },
    ]);
    expect(text).toContain(
      '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=117, session=1, voteNumber=312',
    );
    expect(text).toContain(
      '**Senate Roll Vote:** congressgov_roll_votes chamber=senate, congress=117, session=1, voteNumber=309',
    );
  });

  it('gives a 114th-Congress House roll call none — Congress.gov serves House votes from the 115th', async () => {
    const { rows, text } = await actionsOf(114, 'hamdt', 5);
    expect(rows).toEqual([HOUSE_114_ROLL_ACTION]);
    expect(text).not.toContain('Roll Vote:**');
    expect(text).toContain('rollNumber: 26');
  });

  it('gives a row recording several votes none', async () => {
    /** Built from two real entries: no sampled amendment action records more than one. */
    const both = {
      ...SENATE_312_ACTION,
      recordedVotes: [...SENATE_312_ACTION.recordedVotes, ...SENATE_309_ACTION.recordedVotes],
    };
    apiRoutes.set('/v3/amendment/117/samdt/2137/actions', pagedList('actions', [both]));
    const { rows } = await actionsOf(117, 'samdt', 2137);
    expect(rows).toEqual([both]);
  });

  it('adds no pointer on another sub-resource', async () => {
    apiRoutes.set(
      '/v3/amendment/117/samdt/2137/amendments',
      pagedList('amendments', [
        { ...AMENDMENTS_TO_2137_TAIL[0], recordedVotes: SENATE_312_ACTION.recordedVotes },
      ]),
    );
    const result = await call({
      operation: 'amendments',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2137,
    });
    const rows = (result.structuredContent as { data: Array<Record<string, unknown>> }).data;
    expect('rollVote' in rows[0]!).toBe(false);
  });

  it('pages actions with limit and offset and names the next offset', async () => {
    const result = await call({
      operation: 'actions',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 255,
      limit: 1,
      offset: 1,
    });
    const url = apiRequests()[0]!;
    expect([url.searchParams.get('limit'), url.searchParams.get('offset')]).toEqual(['1', '1']);
    expect(result.structuredContent).toMatchObject({
      data: [HOUSE_OFFERED_ACTION],
      pagination: { count: 3, nextOffset: 2 },
    });
    expect(rendered(result)).toContain('**3 results** | next offset: 2');
  });
});

// ── cosponsors, amendments, text ──────────────────────────────────────

describe('congressgov_amendment_lookup — sub-resources', () => {
  it('returns cosponsors on both surfaces', async () => {
    const result = await call({
      operation: 'cosponsors',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2137,
      limit: 1,
    });
    expect(apiRequests()[0]?.pathname).toBe('/v3/amendment/117/samdt/2137/cosponsors');
    expect(result.structuredContent).toMatchObject({
      data: [PORTMAN_COSPONSOR],
      pagination: { count: 9, nextOffset: 1 },
      totalCount: 9,
      effectiveQuery: 'cosponsors for SAMDT 2137 in the 117th Congress',
    });
    const text = rendered(result);
    expect(text).toContain('### 1. P000449: Sen. Portman, Rob [R-OH]');
    expect(text).toContain('**isOriginalCosponsor:** true');
    expect(text).toContain('**sponsorshipDate:** 2021-08-01');
  });

  it('pages amendments to an amendment to the last row, with no next offset', async () => {
    const result = await call({
      operation: 'amendments',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: '2137',
      limit: 2,
      offset: 505,
    });
    expect(result.structuredContent).toMatchObject({
      data: AMENDMENTS_TO_2137_TAIL,
      pagination: { count: 507, nextOffset: null },
    });
    const text = rendered(result);
    expect(text).toContain('**507 results**');
    expect(text).not.toContain('next offset');
    expect(text).toContain('### 1. SAMDT 2133');
    expect(text).toContain('**Purpose:** To strike a definition.');
    expect(text).toContain('Record Vote Number: 291.');
    expect(text).toContain('https://api.congress.gov/v3/amendment/117/samdt/2131?format=json');
  });

  it('lists every text version with its format URLs', async () => {
    const result = await call({
      operation: 'text',
      congress: 110,
      amendmentType: 'samdt',
      amendmentNumber: 4199,
    });
    expect(result.structuredContent).toMatchObject({
      data: SAMDT_4199_VERSIONS,
      pagination: { count: 2, nextOffset: null },
    });
    const text = rendered(result);
    expect(text).toContain('### 1. Proposed');
    expect(text).toContain('### 2. Submitted');
    for (const version of SAMDT_4199_VERSIONS) {
      for (const format of version.formats)
        expect(text).toContain(`**${format.type}:** ${format.url}`);
    }
  });

  it('reports an empty sub-resource on both surfaces, composed with the ignored-bound notice', async () => {
    const result = await call({
      operation: 'cosponsors',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 255,
      fromDateTime: '2023-01-01T00:00:00Z',
    });
    const notice =
      "'cosponsors' does not use fromDateTime, so it was ignored. No cosponsors found for HAMDT 255.";
    expect(result.structuredContent).toMatchObject({ data: [], notice, totalCount: 0 });
    const text = rendered(result);
    expect(text).toContain('_No matching results._');
    expect(text).toContain(notice);
  });
});

// ── list ──────────────────────────────────────────────────────────────

describe("congressgov_amendment_lookup — 'list'", () => {
  it('browses one congress and type, newest update first, on both surfaces', async () => {
    const result = await call({
      operation: 'list',
      congress: 118,
      amendmentType: 'HAMDT',
      limit: 1,
    });
    const url = apiRequests()[0]!;
    expect(url.pathname).toBe('/v3/amendment/118/hamdt');
    expect(url.searchParams.get('sort')).toBe('updateDate desc');
    expect([url.searchParams.get('limit'), url.searchParams.get('offset')]).toEqual(['1', '0']);
    expect(result.structuredContent).toMatchObject({
      data: [HAMDT_549_ROW],
      pagination: { count: 1235, nextOffset: 1 },
      totalCount: 1235,
      effectiveQuery: 'amendments (congress=118, amendmentType=hamdt)',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = rendered(result);
    expect(text).toContain('**1235 results** | next offset: 1');
    expect(text).toContain('### 1. HAMDT 549');
    expect(text).toContain('**Congress:** 118 | **Updated:** 2026-09-16T16:27:38Z');
    expect(text).toContain(`**Description:** ${HAMDT_549_ROW.description}`);
    expect(text).toContain('Roll no. 572');
    expect(text).toContain('17:26:27');
    expect(text).toContain(`**URL:** ${HAMDT_549_ROW.url}`);
  });

  it('browses every type in a congress when amendmentType is omitted, oldest first on request', async () => {
    await call({ operation: 'list', congress: 118, order: 'oldest' });
    const url = apiRequests()[0]!;
    expect(url.pathname).toBe('/v3/amendment/118');
    expect(url.searchParams.get('sort')).toBe('updateDate asc');
  });

  it('sends the update-date window', async () => {
    await call({
      operation: 'list',
      congress: 118,
      amendmentType: 'hamdt',
      fromDateTime: '2023-01-01T00:00:00Z',
      toDateTime: '2023-12-31T23:59:59Z',
    });
    const url = apiRequests()[0]!;
    expect(url.searchParams.get('fromDateTime')).toBe('2023-01-01T00:00:00Z');
    expect(url.searchParams.get('toDateTime')).toBe('2023-12-31T23:59:59Z');
  });

  it.each([
    { fromDateTime: '2023-01-01' },
    { fromDateTime: '2023-02-30T00:00:00Z' },
    { fromDateTime: '2024-01-01T00:00:00Z', toDateTime: '2023-01-01T00:00:00Z' },
  ])('rejects a malformed or reversed window before any request: %j', async (bounds) => {
    const result = await call({ operation: 'list', congress: 118, ...bounds });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError },
    });
    expect(requested).toHaveLength(0);
  });

  it('refuses amendmentNumber with incompatible_identity before any request', async () => {
    const result = await call({
      operation: 'list',
      congress: 118,
      amendmentType: 'hamdt',
      number: '255',
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'incompatible_identity',
          field: 'amendmentNumber',
          operation: 'list',
          recovery: { hint: expect.stringContaining('Remove the named identity field') },
        },
      },
    });
    expect(rendered(result)).toContain(
      "use 'get' with congress, amendmentType, and amendmentNumber",
    );
    expect(requested).toHaveLength(0);
  });

  it('says where suamdt exists when a later congress has none', async () => {
    const result = await call({ operation: 'list', congress: 118, amendmentType: 'suamdt' });
    const notice =
      'No amendments matched. Senate unprinted amendments (suamdt) exist only in the 97th and 98th Congresses; later Senate amendments are samdt.';
    expect(result.structuredContent).toMatchObject({ data: [], totalCount: 0, notice });
    expect(rendered(result)).toContain(notice);
  });

  it('gives the generic no-match notice for an empty window', async () => {
    apiRoutes.set('/v3/amendment/118/hamdt', {
      body: { amendments: [], pagination: { count: 0 } },
    });
    const result = await call({
      operation: 'list',
      congress: 118,
      amendmentType: 'hamdt',
      fromDateTime: '2030-01-01T00:00:00Z',
    });
    expect(result.structuredContent).toMatchObject({
      notice:
        'No amendments matched the filters. Try broadening the date range or removing amendmentType.',
    });
  });

  it('does not claim no match when the offset ran past the end', async () => {
    const result = await call({
      operation: 'list',
      congress: 118,
      amendmentType: 'hamdt',
      offset: 1235,
    });
    expect(result.structuredContent).toMatchObject({ data: [], totalCount: 1235 });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(rendered(result)).toContain(
      '_Page is empty — offset is past the end of 1235 total items._',
    );
  });
});

// ── content ───────────────────────────────────────────────────────────

describe("congressgov_amendment_lookup — 'content'", () => {
  /** Every value of a `content` window, as `content[]` renders it. */
  function expectWindowRendered(window: Record<string, unknown>, text: string): void {
    const offset = window.offset as number;
    const body = window.text as string;
    expect(text).toContain(`# ${window.documentTitle as string}`);
    expect(text).toContain('**Format:** html');
    expect(text).toContain(
      `**Characters ${(offset + 1).toLocaleString('en-US')}–${(offset + body.length).toLocaleString('en-US')} of ${(window.totalCharacters as number).toLocaleString('en-US')}**`,
    );
    expect(text).toContain(`**Truncated:** ${String(window.truncated)}`);
    expect(text).toContain(
      window.nextOffset === null
        ? '_end of document_'
        : `next offset: ${window.nextOffset as number}`,
    );
    expect(text).toContain(`**Source:** ${window.sourceUrl as string}`);
    expect(text).toContain(`\`\`\`\n${body}\n\`\`\``);
  }

  it("reads the version's HTML as GPO print text, layout kept, on both surfaces", async () => {
    const result = await call({
      operation: 'content',
      congress: 117,
      amendmentType: 'SAMDT',
      amendmentNumber: '2137',
    });
    expect(result.isError).not.toBe(true);
    const lookup = apiRequests()[0]!;
    expect(lookup.pathname).toBe('/v3/amendment/117/samdt/2137/text');
    expect([lookup.searchParams.get('limit'), lookup.searchParams.get('offset')]).toEqual([
      '1',
      '0',
    ]);
    expect(documentRequests().map(String)).toEqual([SAMDT_2137_HTML]);

    const window = (result.structuredContent as { content: Record<string, unknown> }).content;
    expect(window).toEqual({
      text: SAMDT_2137_TEXT,
      totalCharacters: SAMDT_2137_TEXT.length,
      offset: 0,
      truncated: false,
      nextOffset: null,
      format: 'html',
      sourceUrl: SAMDT_2137_HTML,
      documentTitle: 'SAMDT 2137 (117th Congress) — Submitted text',
    });
    expect(result.structuredContent).toMatchObject({
      totalCount: SAMDT_2137_TEXT.length,
      effectiveQuery: `Submitted text of SAMDT 2137 (117th Congress), html characters 0–${SAMDT_2137_TEXT.length}`,
    });
    expectWindowRendered(window, rendered(result));
  });

  it('walks the page via nextOffset and reassembles it exactly', async () => {
    let offset: number | null = 0;
    let assembled = '';
    let windows = 0;
    while (offset !== null) {
      const result = await call({
        operation: 'content',
        congress: 117,
        amendmentType: 'samdt',
        amendmentNumber: 2137,
        characterOffset: offset,
        characterLimit: 200,
      });
      const window = (
        result.structuredContent as { content: { text: string; nextOffset: number | null } }
      ).content;
      assembled += window.text;
      offset = window.nextOffset;
      windows++;
    }
    expect(assembled).toBe(SAMDT_2137_TEXT);
    expect(windows).toBe(Math.ceil(SAMDT_2137_TEXT.length / 200));
  });

  it('selects the text version textVersionIndex names', async () => {
    const result = await call({
      operation: 'content',
      congress: 110,
      amendmentType: 'samdt',
      amendmentNumber: 4199,
      textVersionIndex: 1,
    });
    expect(apiRequests()[0]?.searchParams.get('offset')).toBe('1');
    expect(documentRequests().map(String)).toEqual([SAMDT_4199_VERSIONS[1]!.formats[0]!.url]);
    expect(result.structuredContent).toMatchObject({
      content: {
        text: '[Page S2014]\n  SA 4199. Mr. DORGAN submitted an amendment.',
        documentTitle: 'SAMDT 4199 (110th Congress) — Submitted text',
      },
    });
  });

  it('fails document_unavailable when the index is past the end, naming the count, and fetches no document', async () => {
    const result = await call({
      operation: 'content',
      congress: 110,
      amendmentType: 'samdt',
      amendmentNumber: 4199,
      textVersionIndex: 2,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'document_unavailable',
          textVersionIndex: 2,
          available: 2,
          recovery: { hint: expect.stringContaining("'text'") },
        },
      },
    });
    const text = rendered(result);
    expect(text).toContain(
      'No text version at index 2 for SAMDT 4199 — Congress.gov publishes 2 version(s)',
    );
    expect(text).toContain('Recovery:');
    expect(documentRequests()).toHaveLength(0);
  });

  it('fails document_unavailable for an amendment with no text versions', async () => {
    const result = await call({
      operation: 'content',
      congress: 118,
      amendmentType: 'hamdt',
      amendmentNumber: 205,
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'document_unavailable', available: 0 } },
    });
  });

  it('fails document_unavailable for a version that publishes no formats', async () => {
    const result = await call({
      operation: 'content',
      congress: 97,
      amendmentType: 'suamdt',
      amendmentNumber: 7,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'document_unavailable' } },
    });
    expect(rendered(result)).toContain(
      'The Submitted text of SUAMDT 7 publishes no document formats.',
    );
    expect(documentRequests()).toHaveLength(0);
  });

  it('fails format_unavailable naming the PDF when a version publishes no HTML', async () => {
    /** The SAMDT 2137 version with its HTML entry removed — no sampled version is PDF-only. */
    apiRoutes.set(
      '/v3/amendment/117/samdt/2137/text',
      pagedList('textVersions', [
        {
          date: '2021-08-01T04:00:00Z',
          formats: [{ type: 'PDF', url: SAMDT_2137_PDF }],
          type: 'Submitted',
        },
      ]),
    );
    const result = await call({
      operation: 'content',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2137,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'format_unavailable',
          formats: [{ type: 'PDF', url: SAMDT_2137_PDF }],
          recovery: { hint: expect.stringContaining('PDF URL') },
        },
      },
    });
    expect(rendered(result)).toContain(`It publishes PDF at ${SAMDT_2137_PDF}.`);
    expect(documentRequests()).toHaveLength(0);
  });

  it('fails offset_past_end for a window starting past the last character', async () => {
    const result = await call({
      operation: 'content',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2137,
      characterOffset: SAMDT_2137_TEXT.length,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'offset_past_end',
          recovery: { hint: expect.stringContaining('nextOffset') },
        },
      },
    });
  });

  it('rejects a window above the ceiling at the schema', () => {
    const base = {
      operation: 'content',
      congress: 117,
      amendmentType: 'samdt',
      amendmentNumber: 2137,
    };
    expect(() => amendmentLookupTool.input.parse({ ...base, characterLimit: 100_001 })).toThrow();
    expect(() => amendmentLookupTool.input.parse({ ...base, characterLimit: 0 })).toThrow();
    expect(() => amendmentLookupTool.input.parse({ ...base, textVersionIndex: -1 })).toThrow();
    expect(amendmentLookupTool.input.parse(base)).toMatchObject({
      characterOffset: 0,
      characterLimit: 25_000,
      textVersionIndex: 0,
    });
  });
});

// ── Description ───────────────────────────────────────────────────────

describe('congressgov_amendment_lookup — description', () => {
  it('names the tools whose rows carry the identifiers it takes, and the roll vote chain', () => {
    for (const name of [
      'congressgov_bill_lookup',
      'congressgov_roll_votes',
      'congressgov_member_lookup',
      'rollVote',
    ]) {
      expect(amendmentLookupTool.description).toContain(name);
    }
  });
});

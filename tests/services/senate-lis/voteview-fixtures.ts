/**
 * @fileoverview The 2026-11-04 captures behind the Senate vote fallback —
 * Voteview's per-congress files trimmed to a few roll calls, Voteview's 404 page,
 * and the page senate.gov's firewall serves a refused client — plus a fetch stub
 * that routes each request by host and records it, and responses whose body
 * breaks off or stalls mid-read.
 * @module tests/services/senate-lis/voteview-fixtures
 */

import { existsSync, readFileSync } from 'node:fs';
import type { VoteviewFiles } from '@/services/senate-lis/voteview-parse.js';

const CAPTURE_DIR = new URL('./fixtures/voteview-2026-11-04/', import.meta.url);

/** A file from the capture directory, as text. */
export function capturedFile(name: string): string {
  return readFileSync(new URL(name, CAPTURE_DIR), 'utf8');
}

/**
 * The congresses captured. Rows are trimmed to whole roll calls, never edited;
 * each members file is whole.
 * - 119th: session 1 votes 1 and 13 (13 carries the President's position) and
 *   session 2 votes 254–256, the last Voteview's latest as captured
 * - 118th: session 2 vote 1 and vote 336, the votes of the LIS fixtures
 *   `vote-cloture.xml` and `vote-amendment.xml`
 * - 101st: session 2 votes 175 and 317, numbers written `2.0`/`175.0`, with paired,
 *   announced, and present positions and the President's
 */
export type CapturedCongress = 101 | 118 | 119;

export function capturedCongress(congress: CapturedCongress): VoteviewFiles {
  return {
    rollcalls: capturedFile(`S${congress}_rollcalls.csv`),
    votes: capturedFile(`S${congress}_votes.csv`),
    members: capturedFile(`S${congress}_members.csv`),
  };
}

/** The three file URLs of a congress, as Voteview publishes them. */
export function voteviewFileUrls(congress: number): string[] {
  return ['rollcalls', 'votes', 'members'].map(
    (kind) => `https://voteview.com/static/data/out/${kind}/S${congress}_${kind}.csv`,
  );
}

/** The citation Voteview's data page asks for (voteview.com/data, 2026-11-04). */
export const VOTEVIEW_CITATION_TEXT =
  'Lewis, Jeffrey B., Keith Poole, Howard Rosenthal, Adam Boche, Aaron Rudkin, and Luke Sonnet (2026). Voteview: Congressional Roll-Call Votes Database. https://voteview.com/';

/** The `source` a call answered from the 119th capture carries: Voteview's latest vote as captured. */
export const CAPTURED_SOURCE_119 = {
  name: 'Voteview',
  url: 'https://voteview.com/',
  congress: 119,
  latestVote: { session: 2, voteNumber: 256, date: '2026-09-30' },
  citation: VOTEVIEW_CITATION_TEXT,
} as const;

/**
 * What senate.gov's firewall served a non-browser client, with HTTP 403. The
 * captured pages keep a `.txt` suffix so the linter never parses or rewrites them.
 */
export const SENATE_FIREWALL_PAGE = capturedFile('lis-403-firewall-2026-11-04.html.txt');
/** What Voteview served for a file it does not have, with HTTP 404. */
export const VOTEVIEW_404_PAGE = capturedFile('voteview-404-2026-11-04.html.txt');

export const SENATE_HOST = 'www.senate.gov';
export const VOTEVIEW_HOST = 'voteview.com';

/** A response as `fetchWithTimeout` reads one: status, headers, and the body as text. */
export function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    text: async () => body,
  };
}

/** Answers one request; `init.signal` is the request's abort signal. */
export type Responder = (url: URL, init: RequestInit | undefined) => Promise<unknown>;

/**
 * A `fetch` that routes each request by host and records every URL asked for.
 * A host with no route rejects, as an unreachable one does.
 */
export function routeFetch(routes: Readonly<Record<string, Responder>>) {
  const requests: URL[] = [];
  const fetch = (input: string | URL, init?: RequestInit): Promise<unknown> => {
    const url = new URL(String(input));
    requests.push(url);
    const respond = Object.hasOwn(routes, url.hostname) ? routes[url.hostname] : undefined;
    return respond
      ? respond(url, init)
      : Promise.reject(new Error(`unexpected host ${url.hostname}`));
  };
  return {
    fetch,
    requests,
    hits: (host: string) => requests.filter((url) => url.hostname === host).length,
  };
}

const VOTEVIEW_FILE_PATH = /^\/static\/data\/out\/(rollcalls|votes|members)\/(S\d+_\1\.csv)$/;

/**
 * Voteview as captured: `/static/data/out/{kind}/S{congress}_{kind}.csv` answers
 * with that captured file — or with `files[name]`, which overrides or adds a
 * file — and any other path with Voteview's 404 page.
 */
export function voteviewServing(files: Readonly<Record<string, string>> = {}): Responder {
  return async (url) => {
    const name = VOTEVIEW_FILE_PATH.exec(url.pathname)?.[2];
    if (name !== undefined && Object.hasOwn(files, name))
      return textResponse(files[name] as string);
    if (name !== undefined && existsSync(new URL(name, CAPTURE_DIR))) {
      return textResponse(capturedFile(name));
    }
    return textResponse(VOTEVIEW_404_PAGE, 404);
  };
}

/** Rejects with the signal's reason once it aborts, as an interrupted `fetch` does; never resolves. */
function abortOf(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** A request that never answers. */
export const neverAnswers: Responder = (_url, init) => abortOf(init?.signal);

/** The first half of `body`'s bytes, the most a broken-off response delivers. */
function firstHalf(body: string): Uint8Array {
  const bytes = new TextEncoder().encode(body);
  return bytes.subarray(0, bytes.length >> 1);
}

/**
 * A 200 whose body breaks off halfway, as a reset connection ends one: the read
 * rejects with `TypeError: terminated`, as undici reports it.
 */
export function cutOffResponse(body: string): Response {
  const half = firstHalf(body);
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('terminated'));
          return;
        }
        sent = true;
        controller.enqueue(half);
      },
    }),
    { status: 200 },
  );
}

/**
 * Answers 200 with half of `body`, then holds the rest until the request's signal
 * aborts and errors the body with the abort reason, as an interrupted `fetch`
 * body does. `stalls` counts the reads now held mid-body.
 */
export function stalledMidBody(body: string) {
  const state = { stalls: 0, signals: [] as AbortSignal[] };
  const responder: Responder = async (_url, init) => {
    const signal = init?.signal ?? undefined;
    if (signal) state.signals.push(signal);
    const half = firstHalf(body);
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(half);
            return;
          }
          state.stalls++;
          return abortOf(signal).catch((reason: unknown) => controller.error(reason));
        },
      }),
      { status: 200 },
    );
  };
  return { responder, state };
}

/**
 * Holds every response of `respond` until `release()`, recording each request's
 * signal. A request whose signal aborts first rejects with the abort reason.
 */
export function heldUntilReleased(respond: Responder) {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const responder: Responder = async (url, init) => {
    if (init?.signal) signals.push(init.signal);
    await Promise.race([released, abortOf(init?.signal)]);
    return respond(url, init);
  };
  return { responder, release: () => release(), signals };
}

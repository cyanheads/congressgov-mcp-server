/**
 * @fileoverview Resolve a requested document format to its upstream URL: GPO
 * format lists, CRS report formats, and the part a committee report's format
 * URL belongs to.
 * @module services/congress-documents/document-formats
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import type { CrsFormatRef, DocumentFormat, DocumentFormatRef } from './types.js';

export const DOCUMENT_FORMATS = ['text', 'xml'] as const;

/**
 * Upstream `type` labels for each supported format, in preference order.
 *
 * `Formatted Text` is GPO's `<pre>`-wrapped print output and is the only format
 * present on every document checked — bills back to 1999, committee reports, and
 * Daily Record articles. XML is inconsistent: `United States Legislative Markup`
 * ships on some newer bill versions, the legacy `Formatted XML` on many more, and
 * neither on committee reports or the Daily Record. PDF is not offered.
 */
export const DOCUMENT_FORMAT_LABELS: Record<DocumentFormat, readonly string[]> = {
  text: ['Formatted Text'],
  xml: ['United States Legislative Markup', 'Formatted XML'],
};

function refUrl(ref: DocumentFormatRef): string | undefined {
  return typeof ref.url === 'string' && ref.url.trim() !== '' ? ref.url.trim() : undefined;
}

function matchesLabel(ref: DocumentFormatRef, label: string): boolean {
  return typeof ref.type === 'string' && ref.type.trim().toLowerCase() === label.toLowerCase();
}

/**
 * Pick the URL for `format` from an upstream format list.
 *
 * Labels are tried in preference order, and within one label a non-errata entry
 * wins over an errata reprint — committee reports publish both under the same
 * `Formatted Text` label and the errata is the correction, not the report.
 * Returns `undefined` when the document publishes nothing in this format, which
 * callers surface as the `format_unavailable` contract failure.
 */
export function selectDocumentUrl(entries: unknown, format: DocumentFormat): string | undefined {
  if (!Array.isArray(entries)) return;
  const refs = entries.filter(
    (entry): entry is DocumentFormatRef => typeof entry === 'object' && entry !== null,
  );

  for (const label of DOCUMENT_FORMAT_LABELS[format]) {
    const matched = refs.filter((ref) => matchesLabel(ref, label) && refUrl(ref) !== undefined);
    const preferred = matched.find((ref) => ref.isErrata !== 'Y') ?? matched[0];
    const url = preferred ? refUrl(preferred) : undefined;
    if (url) return url;
  }
  return;
}

/** The upstream labels a format resolves to, for error messages that name what was searched. */
export function describeFormat(format: DocumentFormat): string {
  return DOCUMENT_FORMAT_LABELS[format].join(' / ');
}

/** A published CRS format: its label as upstream writes it, and its URL. */
interface CrsFormat {
  format: string;
  url: string;
}

/** The entries of a CRS `formats[]` that carry a usable URL. */
function crsFormats(formats: unknown): CrsFormat[] {
  if (!Array.isArray(formats)) return [];
  return formats.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { format, url } = entry as CrsFormatRef;
    if (typeof url !== 'string' || url.trim() === '') return [];
    return [{ format: typeof format === 'string' ? format.trim() : '', url: url.trim() }];
  });
}

/**
 * Pick the HTML rendition of a CRS report from its `formats[]` — the one CRS
 * format this server reads as text, through the `html` reading.
 *
 * CRS labels each entry `HTML` or `PDF`, and the HTML path does not follow the
 * report ID (`/RA/HTML/RL32893.html`, `/RL/HTML/93-931.html`), so the URL is
 * always the one the entry publishes, never one built from the ID.
 *
 * @throws `NotFound`, reason `format_unavailable`, naming every published
 *   format and its URL in the message and in `data.formats`, when the report
 *   publishes formats but no HTML (the oldest reports are PDF only).
 * @throws `NotFound`, reason `document_unavailable`, when it publishes no
 *   format with a URL at all.
 */
export function selectCrsDocumentUrl(formats: unknown, reportNumber: string): string {
  const published = crsFormats(formats);
  const html = published.find((entry) => entry.format.toUpperCase() === 'HTML');
  if (html) return html.url;
  if (published.length === 0) {
    throw notFound(`CRS report ${reportNumber} publishes no document formats.`, {
      reason: 'document_unavailable',
      reportNumber,
      retryable: false,
    });
  }
  const listed = published.map((entry) => `${entry.format || 'unlabeled'} at ${entry.url}`);
  throw notFound(
    `CRS report ${reportNumber} publishes no HTML version, the one format this server reads as text. It publishes ${listed.join('; ')}.`,
    {
      reason: 'format_unavailable',
      reportNumber,
      formats: published,
      retryable: false,
    },
  );
}

/**
 * The `-pt{N}` marker in a committee report file name, ended by the extension,
 * a hyphen (`err-pt3-ERRATA`), or the end of the name.
 */
const PART_MARKER_RE = /-pt(\d+)(?=[.-]|$)/i;

/**
 * The part of a multi-part committee report a format URL belongs to: the `N`
 * of a `-pt{N}` marker in its file name, else 1.
 *
 * Congress.gov files each part as its own record and lists every part's
 * formats under one report number. Part 1 is unsuffixed (`CRPT-117hrpt70.htm`)
 * or `-pt1` (Book-style reports and the 110th Congress); later parts carry
 * `-pt{N}`, and an errata file carries its part as `err-pt{N}-ERRATA`. Only
 * the file name is read — never a directory, query, or fragment.
 */
export function formatUrlPart(url: string): number {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  const marker = PART_MARKER_RE.exec(path.slice(path.lastIndexOf('/') + 1));
  return marker ? Number(marker[1]) : 1;
}

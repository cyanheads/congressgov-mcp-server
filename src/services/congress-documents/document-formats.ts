/**
 * @fileoverview Resolve a requested document format to its upstream URL.
 * @module services/congress-documents/document-formats
 */

import type { DocumentFormat, DocumentFormatRef } from './types.js';

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

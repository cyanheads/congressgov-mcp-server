/**
 * @fileoverview Congress numbering arithmetic shared by the API, Senate LIS, and mirror
 * services and the server config: the 1st Congress sat in 1789 and each Congress since
 * spans two years.
 * @module utils/congress-calendar
 */

/** Calendar year the 1st Congress opened in. */
export const FIRST_CONGRESS_YEAR = 1789;

/** English ordinal for a congress number — "118" → "118th". */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** A digit string reads as its ordinal ("102" → "102nd"); any other value ("118th") is kept as written. */
export function congressOrdinal(congress: string): string {
  return /^\d+$/.test(congress) ? ordinal(Number(congress)) : congress;
}

/** The calendar year a congress opens in — the 118th opened in 2023. Takes a positive integer. */
export function congressFirstYear(congress: number): number {
  return FIRST_CONGRESS_YEAR + 2 * (congress - 1);
}

/** Congress number covering a given date (2025–2026 → 119). */
export function currentCongressNumber(date: Date = new Date()): number {
  return Math.floor((date.getUTCFullYear() - FIRST_CONGRESS_YEAR) / 2) + 1;
}

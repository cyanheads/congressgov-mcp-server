/**
 * @fileoverview Resource providing a reference table of valid bill type codes.
 * @module mcp-server/resources/definitions/bill-types
 */

import { resource } from '@cyanheads/mcp-ts-core';

const BILL_TYPES = [
  { code: 'hr', description: 'House Bill', chamber: 'House', example: 'H.R. 1234' },
  { code: 's', description: 'Senate Bill', chamber: 'Senate', example: 'S. 1234' },
  { code: 'hjres', description: 'House Joint Resolution', chamber: 'House', example: 'H.J.Res. 1' },
  {
    code: 'sjres',
    description: 'Senate Joint Resolution',
    chamber: 'Senate',
    example: 'S.J.Res. 1',
  },
  {
    code: 'hconres',
    description: 'House Concurrent Resolution',
    chamber: 'House',
    example: 'H.Con.Res. 1',
  },
  {
    code: 'sconres',
    description: 'Senate Concurrent Resolution',
    chamber: 'Senate',
    example: 'S.Con.Res. 1',
  },
  { code: 'hres', description: 'House Simple Resolution', chamber: 'House', example: 'H.Res. 1' },
  { code: 'sres', description: 'Senate Simple Resolution', chamber: 'Senate', example: 'S.Res. 1' },
];

export const billTypesResource = resource('congress://bill-types', {
  name: 'bill-types',
  description: 'Reference table of valid bill type codes (hr, s, hjres, etc.) with descriptions.',
  mimeType: 'application/json',

  handler() {
    return { billTypes: BILL_TYPES };
  },
});

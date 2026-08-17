/**
 * @fileoverview Tests for congress://bill-types resource.
 * @module tests/mcp-server/resources/definitions/bill-types.resource.test
 */

import { describe, expect, it } from 'vitest';
import { billTypesResource } from '@/mcp-server/resources/definitions/bill-types.resource.js';

type BillTypesResult = {
  billTypes: { code: string; description: string; chamber: string; example: string }[];
};

const read = () => billTypesResource.handler({}, {} as any) as BillTypesResult;

describe('billTypesResource', () => {
  it('returns all 8 bill type codes', () => {
    expect(read().billTypes).toHaveLength(8);
  });

  it('includes expected bill type codes', () => {
    const codes = read().billTypes.map((bt) => bt.code);
    expect(codes).toEqual(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']);
  });

  it('each bill type has code, description, chamber, and example', () => {
    for (const bt of read().billTypes) {
      expect(bt).toHaveProperty('code');
      expect(bt).toHaveProperty('description');
      expect(bt).toHaveProperty('chamber');
      expect(bt).toHaveProperty('example');
    }
  });
});

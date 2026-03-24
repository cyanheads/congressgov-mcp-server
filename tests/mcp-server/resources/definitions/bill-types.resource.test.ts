/**
 * @fileoverview Tests for congress://bill-types resource.
 * @module tests/mcp-server/resources/definitions/bill-types.resource.test
 */

import { describe, expect, it } from 'vitest';
import { billTypesResource } from '@/mcp-server/resources/definitions/bill-types.resource.js';

describe('billTypesResource', () => {
  it('returns all 8 bill type codes', () => {
    const result = billTypesResource.handler({}, {} as any);
    expect(result.billTypes).toHaveLength(8);
  });

  it('includes expected bill type codes', () => {
    const result = billTypesResource.handler({}, {} as any);
    const codes = result.billTypes.map((bt: { code: string }) => bt.code);
    expect(codes).toEqual(['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres']);
  });

  it('each bill type has code, description, chamber, and example', () => {
    const result = billTypesResource.handler({}, {} as any);
    for (const bt of result.billTypes) {
      expect(bt).toHaveProperty('code');
      expect(bt).toHaveProperty('description');
      expect(bt).toHaveProperty('chamber');
      expect(bt).toHaveProperty('example');
    }
  });
});

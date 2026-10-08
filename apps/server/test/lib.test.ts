import { describe, expect, it } from 'vitest';
import { canonicalJson, stableHash } from '../src/lib/hash.ts';
import { createRedactor } from '../src/lib/redact.ts';

describe('createRedactor', () => {
  it('masks every secret by exact value in text and nested data', () => {
    const r = createRedactor(['token-aaaaaaaaaaaa', 'key-bbbbbbbbbbbb']);
    expect(r.text('a token-aaaaaaaaaaaa b key-bbbbbbbbbbbb')).toBe('a *** b ***');
    expect(r.deep({ list: ['x token-aaaaaaaaaaaa'], n: 1, nested: { v: 'key-bbbbbbbbbbbb' } })).toEqual({ list: ['x ***'], n: 1, nested: { v: '***' } });
  });

  it('ignores short values so ordinary words are not masked', () => {
    expect(createRedactor(['abc']).text('abc')).toBe('abc');
  });

  it('masks a longer secret before a shorter one it contains', () => {
    expect(createRedactor(['secret-12345', 'secret-12345-extended']).text('secret-12345-extended')).toBe('***');
  });

  it('masks a secret added after start, for example a token of the integrations screen, together with the first ones', () => {
    const r = createRedactor(['secret-12345']);
    r.add('secret-12345-extended');
    r.add('abc');
    expect(r.text('secret-12345-extended и secret-12345 и abc')).toBe('*** и *** и abc');
  });
});

describe('stableHash', () => {
  it('does not depend on the order of object keys', () => {
    expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(stableHash({ branch: 'feature/TEAM-1' })).not.toBe(stableHash({ branch: 'feature/TEAM-2' }));
  });

  it('treats undefined fields as absent', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

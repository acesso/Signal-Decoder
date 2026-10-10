/**
 * CAT capability report (CL;) tests — list parsing, the ?; fallback to the
 * legacy query list, and the state query built from the radio's own list.
 *
 * Run with: npm test src/lib/cat/__tests__/catCapabilities.test.ts
 */

import { LEGACY_POLL_CMDS, parseQueryList, stateQueryCmds, supportsQuery } from '../catCapabilities';

const FULL_LIST = 'CLFA,MD,IF,ID,FV,PS,SM,AI,TQ,AG0,FW,VO,AT,A2,NR,DR,BL,AL,TT,PM,PX,XF,FD,TU,TA,DG,CL;';

describe('parseQueryList', () => {
  test('a CL frame → the listed queries', () => {
    const list = parseQueryList(FULL_LIST);
    expect(list).toContain('AG0');
    expect(list).toContain('DG');
    expect(Array.isArray(list) && list.length).toBe(27);
  });

  test('?; (older firmware) → unsupported', () => {
    expect(parseQueryList('?;')).toBe('unsupported');
  });

  test.each(['__timeout__', '__dedup__', '', 'CL;', 'CLFA,,MD;', 'FV4.02c;'])('%j → null (retry)', (reply) => {
    expect(parseQueryList(reply)).toBeNull();
  });
});

describe('supportsQuery', () => {
  test('no list → only the legacy queries count', () => {
    expect(supportsQuery(null, 'FA')).toBe(true);
    expect(supportsQuery(null, 'AG0;')).toBe(true);
    expect(supportsQuery(null, 'DG')).toBe(false);
    expect(supportsQuery(null, 'TU')).toBe(false);
  });

  test('with a list → the list decides', () => {
    expect(supportsQuery(['FA', 'TU'], 'TU;')).toBe(true);
    expect(supportsQuery(['FA', 'TU'], 'DG')).toBe(false);
  });
});

describe('stateQueryCmds', () => {
  test('no list → the legacy list, unchanged', () => {
    expect(stateQueryCmds(null)).toEqual(LEGACY_POLL_CMDS);
  });

  test('full list (TX_DIAG build) → legacy queries plus DG', () => {
    const list = parseQueryList(FULL_LIST) as string[];
    expect(stateQueryCmds(list)).toEqual([...LEGACY_POLL_CMDS, 'DG;']);
  });

  test('build without TX_DIAG → no DG', () => {
    const list = parseQueryList(FULL_LIST.replace(',TA,DG', '')) as string[];
    expect(stateQueryCmds(list)).toEqual(LEGACY_POLL_CMDS);
  });

  test('only what the radio lists is queried', () => {
    expect(stateQueryCmds(['FA', 'MD', 'SM'])).toEqual(['FA;', 'MD;', 'SM;']);
  });
});

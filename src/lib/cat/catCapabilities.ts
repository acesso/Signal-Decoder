/**
 * CAT capability report (uSDX BLACK_BRICK `CL;`).
 *
 * Firmware with the capability report answers `CL;` with every read-only
 * query it supports in one frame, e.g. `CLFA,MD,IF,…,TU,TA,DG,CL;`. Older
 * firmware answers `?;` (its reply to any unknown command). Both builds
 * report the same version (`FV4.02c;`), so the reply itself is the version
 * gate: a list → query only what the radio lists; `?;` → the fixed query
 * list every earlier firmware supports.
 */

/** The fixed state query used before the capability report existed — and
 *  still used whenever the radio doesn't answer `CL;` with a list. */
export const LEGACY_POLL_CMDS = ['FA;', 'MD;', 'AG0;', 'FW;', 'VO;', 'AT;', 'A2;', 'NR;', 'SM;', 'DR;', 'BL;', 'AL;'];

/** Extra state queries the app adds to the state query when the radio
 *  lists them (never sent to firmware without the capability report). */
const OPTIONAL_POLL_CMDS = ['DG;'];

/** Result of a `CL;` exchange: the listed queries, 'unsupported' for a `?;`
 *  answer (older firmware), or null when the reply is missing/garbled. */
export type QueryListReply = string[] | 'unsupported' | null;

export function parseQueryList(reply: string): QueryListReply {
  if (reply === '?;') return 'unsupported';
  const m = reply.match(/^CL([A-Z0-9]+(?:,[A-Z0-9]+)*);$/);
  return m ? m[1].split(',') : null;
}

/** Does the radio answer this query? With no list (older firmware, or the
 *  report not answered yet) only the legacy queries count as supported. */
export function supportsQuery(list: string[] | null, cmd: string): boolean {
  const name = cmd.replace(/;$/, '');
  return list === null ? LEGACY_POLL_CMDS.includes(`${name};`) : list.includes(name);
}

/** The state query for this radio: the legacy list as-is without a
 *  capability report, otherwise only the listed legacy queries plus the
 *  listed optional ones. */
export function stateQueryCmds(list: string[] | null): string[] {
  if (list === null) return LEGACY_POLL_CMDS;
  return [...LEGACY_POLL_CMDS, ...OPTIONAL_POLL_CMDS].filter(c => supportsQuery(list, c));
}

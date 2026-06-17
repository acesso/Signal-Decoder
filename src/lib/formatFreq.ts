/** Format absolute frequency in Hz with dot-separated thousands groups.
 *  e.g. 14225750 → "14.225.750" */
export function fmtAbsHz(hz: number): string {
  return Math.round(hz).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Format absolute frequency in MHz for axis labels.
 *  e.g. 14225750 → "14.225" */
export function fmtAbsMHz(hz: number): string {
  const mhzInt  = Math.floor(hz / 1_000_000);
  const khzFrac = Math.round((hz % 1_000_000) / 1000);
  return `${mhzInt}.${String(khzFrac).padStart(3, '0')}`;
}

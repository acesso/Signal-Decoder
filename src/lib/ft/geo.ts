// Geographic plausibility check: does a reported Maidenhead grid make sense
// for the country implied by the callsign's ITU prefix?
//
// A prefix-valid callsign produced by a bit-error decode usually carries a
// grid thousands of km from the country the prefix belongs to (a "Norwegian"
// station gridding in Korea, a "US" station in the open South Atlantic).
// Each country is covered by one or more circles (centroid + radius, km);
// a grid is plausible if it falls within radius + slack of ANY circle.
//
// Radii are deliberately generous — this check exists to catch
// continent-scale nonsense, not to police borders. Countries whose overseas
// territories have their own prefix (FY→GF, VP9→BM, …) only cover the
// metropolitan area; territories that share the parent prefix (US pacific
// KH*/KL7/KP4, Brazil's oceanic islands, Norway's Svalbard, …) get extra
// circles. Unknown country codes fail OPEN (plausible) — the geo check must
// never reject on our own table gaps.

type Circle = [lat: number, lon: number, radiusKm: number];

/** Distance slack added to every circle radius (grid-square quantization,
 *  table imprecision, operators right at a border). */
export const GEO_SLACK_KM = 500;

const REGIONS: Record<string, Circle[]> = {
  AC: [[-7.95, -14.36, 300]],
  AD: [[42.5, 1.5, 200]],
  AE: [[24, 54, 400]],
  AF: [[34, 66, 700]],
  AG: [[17.08, -61.8, 200]],
  AI: [[18.2, -63.05, 150]],
  AL: [[41, 20, 300]],
  AM: [[40.3, 45, 300]],
  AO: [[-12.5, 17.5, 900]],
  AR: [[-35, -65, 1900]],
  AT: [[47.5, 14, 400]],
  AU: [[-25, 134, 2600], [-29, 168, 500], [-11, 102, 900]], // + Norfolk, Cocos/Christmas
  AW: [[12.5, -70, 150]],
  AZ: [[40.3, 47.5, 350]],
  BA: [[44, 18, 300]],
  BB: [[13.2, -59.5, 150]],
  BD: [[23.7, 90.3, 400]],
  BE: [[50.6, 4.5, 250]],
  BF: [[12.5, -1.5, 500]],
  BG: [[42.7, 25.3, 350]],
  BH: [[26, 50.5, 150]],
  BI: [[-3.4, 29.9, 250]],
  BJ: [[9.5, 2.3, 400]],
  BL: [[17.9, -62.8, 100]],
  BM: [[32.3, -64.75, 150]],
  BN: [[4.5, 114.7, 250]],
  BO: [[-17, -64.5, 900]],
  BR: [[-10, -53, 2400], [-4, -33, 500], [-20.5, -29.3, 300]], // + Noronha, Trindade
  BS: [[24, -76, 500]],
  BT: [[27.5, 90.5, 250]],
  BW: [[-22, 24, 600]],
  BY: [[53.5, 28, 450]],
  BZ: [[17.2, -88.5, 250]],
  CA: [[51, -110, 1800], [49, -70, 1800], [70, -95, 2000]],
  CD: [[-3, 23, 1100]],
  CF: [[6.5, 20.5, 700]],
  CG: [[-1, 15.5, 500]],
  CH: [[46.8, 8.2, 250]],
  CI: [[7.5, -5.5, 450]],
  CK: [[-16, -160, 800]],
  CL: [[-30, -71, 1600], [-50, -73, 900], [-27.1, -109.4, 300]], // + Easter Is.
  CM: [[5.5, 12.5, 600]],
  CN: [[36, 104, 2600]],
  CO: [[4, -73, 800], [12.5, -81.7, 300]], // + San Andrés
  CR: [[10, -84, 300], [5.5, -87, 300]],   // + Cocos Is.
  CU: [[21.5, -79.5, 600]],
  CV: [[16, -24, 400]],
  CW: [[12.2, -69, 250], [18, -63, 150]],  // PJ2-4 Curaçao/Bonaire + PJ5-8 St Maarten/Saba
  CY: [[35, 33, 200]],
  CZ: [[49.8, 15.5, 300]],
  DE: [[51, 10, 500]],
  DJ: [[11.7, 42.7, 200]],
  DK: [[56, 10, 350]],
  DM: [[15.4, -61.35, 100]],
  DO: [[19, -70.5, 250]],
  DZ: [[28, 3, 1100]],
  EC: [[-1.5, -78.5, 400], [-0.7, -90.5, 400]], // + Galápagos
  EE: [[58.7, 25.5, 250]],
  EG: [[26.5, 30, 600]],
  ER: [[15.5, 39, 400]],
  ES: [[40, -3.5, 600], [28.3, -16, 400]], // + Canaries (EA8)
  ET: [[9, 39.5, 700]],
  FI: [[64.5, 26, 700]],
  FJ: [[-17.8, 178, 600]],
  FK: [[-51.7, -59, 300]],
  FM: [[6.5, 150.5, 1400]],
  FO: [[62, -6.8, 150]],
  FR: [[46.5, 2.5, 700]],
  GA: [[-0.8, 11.6, 450]],
  GB: [[54, -2.5, 700]],
  GD: [[12.1, -61.7, 100]],
  GE: [[42, 43.5, 300]],
  GF: [[4, -53, 300]],
  GH: [[8, -1, 400]],
  GI: [[36.1, -5.35, 100]],
  GM: [[13.4, -15.5, 250]],
  GN: [[10.5, -11, 400]],
  GP: [[16.2, -61.5, 150]],
  GQ: [[1.6, 10.3, 300]],
  GR: [[38.5, 23.5, 500]],
  GT: [[15.5, -90.3, 300]],
  GW: [[12, -15, 250]],
  GY: [[5, -59, 450]],
  HK: [[22.3, 114.2, 100]],
  HN: [[14.8, -86.5, 350]],
  HR: [[45, 16, 350]],
  HT: [[19, -72.7, 200]],
  HU: [[47, 19.5, 300]],
  ID: [[-3, 112, 1500], [-3, 133, 1200]],
  IE: [[53.2, -8, 300]],
  IL: [[31.5, 35, 250]],
  IN: [[22, 79, 1500], [11.7, 92.7, 400]], // + Andaman/Nicobar (VU4)
  IQ: [[33, 44, 500]],
  IR: [[32.5, 54, 1100]],
  IS: [[65, -18.5, 350]],
  IT: [[42.5, 12.5, 700]],
  JM: [[18.1, -77.3, 150]],
  JO: [[31.3, 36.5, 300]],
  JP: [[33, 135, 1700]], // covers Hokkaidō through Okinawa/Ogasawara
  KE: [[0.5, 38, 500]],
  KG: [[41.5, 74.5, 400]],
  KH: [[12.5, 105, 350]],
  KI: [[1.4, 173, 500], [-3.5, -172.5, 500], [2, -157.4, 700]], // Gilbert/Phoenix/Line
  KM: [[-11.7, 43.3, 200]],
  KN: [[17.3, -62.7, 100]],
  KP: [[40, 127, 350]],
  KR: [[36.5, 127.8, 350]],
  KW: [[29.3, 47.7, 150]],
  KY: [[19.3, -81.3, 150]],
  KZ: [[48, 67, 1400]],
  LA: [[18, 104, 500]],
  LB: [[33.9, 35.9, 120]],
  LC: [[13.9, -61, 100]],
  LI: [[47.15, 9.55, 60]],
  LK: [[7.7, 80.7, 250]],
  LR: [[6.5, -9.5, 300]],
  LS: [[-29.5, 28.3, 200]],
  LT: [[55.2, 24, 250]],
  LU: [[49.8, 6.1, 100]],
  LV: [[56.9, 24.9, 250]],
  LY: [[27, 17.5, 900]],
  MA: [[31.8, -6.5, 700]],
  MC: [[43.73, 7.42, 50]],
  MD: [[47.2, 28.5, 200]],
  ME: [[42.7, 19.3, 150]],
  MF: [[18.07, -63.05, 80]],
  MG: [[-19.5, 46.5, 700]],
  MH: [[8, 168.5, 700]],
  MK: [[41.6, 21.7, 150]],
  ML: [[17.5, -3.5, 900]],
  MM: [[20, 96.5, 800]],
  MN: [[46.8, 103, 1100]],
  MO: [[22.16, 113.55, 60]],
  MQ: [[14.65, -61, 100]],
  MR: [[20.5, -10.5, 750]],
  MT: [[35.9, 14.4, 80]],
  MU: [[-20, 60, 700]], // Mauritius + Rodrigues (3B9)
  MV: [[3.2, 73.2, 500]],
  MW: [[-13.5, 34, 400]],
  MX: [[23.5, -102, 1600]],
  MY: [[4, 102, 450], [3.5, 114, 700]], // peninsula + Borneo states
  MZ: [[-18, 35, 900]],
  NA: [[-22.5, 17, 700]],
  NC: [[-21.3, 165.5, 400]],
  NE: [[17.5, 9, 750]],
  NG: [[9.5, 8, 600]],
  NI: [[12.8, -85, 300]],
  NL: [[52.2, 5.5, 200]],
  NO: [[61, 9, 700], [69, 20, 600], [78.5, 16, 500], [71, -8.3, 200]], // + Svalbard (JW), Jan Mayen (JX)
  NP: [[28.2, 84, 400]],
  NR: [[-0.5, 166.9, 80]],
  NU: [[-19.05, -169.9, 80]],
  NZ: [[-41, 173, 900], [-44, -176.5, 300]], // + Chatham (ZL7)
  OM: [[21, 57, 600]],
  PA: [[8.5, -80, 400]],
  PE: [[-9.5, -75, 1100]],
  PF: [[-17.5, -149.5, 1200], [-9.5, -139.5, 600]], // Society/Tuamotu + Marquesas
  PG: [[-6.5, 146, 1100]],
  PH: [[12, 122.5, 900]],
  PK: [[29.5, 68.5, 800]],
  PL: [[52, 19.5, 400]],
  PM: [[46.9, -56.3, 100]],
  PS: [[31.9, 35.2, 100]],
  PT: [[39.5, -8, 350], [38.5, -28, 500], [32.75, -17, 300]], // + Azores (CU), Madeira (CT3)
  PW: [[7.4, 134.5, 300]],
  PY: [[-23.5, -58, 550]],
  QA: [[25.3, 51.2, 120]],
  RE: [[-21.1, 55.5, 150]],
  RO: [[46, 25, 400]],
  RS: [[44, 20.8, 300]],
  RU: [[57, 40, 1500], [60, 75, 1500], [58, 105, 1500], [60, 135, 1500], [55, 160, 1500]],
  RW: [[-2, 30, 150]],
  SA: [[24, 45, 1100]],
  SB: [[-9, 160, 700]],
  SC: [[-6, 51, 900]],
  SD: [[15.5, 30, 900]],
  SE: [[62, 15, 850]],
  SG: [[1.35, 103.8, 60]],
  SH: [[-15.95, -5.7, 150]],
  SI: [[46.1, 14.8, 150]],
  SK: [[48.7, 19.5, 250]],
  SL: [[8.5, -11.8, 250]],
  SM: [[43.94, 12.45, 40]],
  SN: [[14.5, -14.5, 350]],
  SO: [[5.5, 46, 800]],
  SR: [[4, -56, 300]],
  SS: [[7.5, 30, 500]],
  ST: [[0.25, 6.6, 150]],
  SV: [[13.7, -88.9, 150]],
  SY: [[35, 38.5, 350]],
  SZ: [[-26.5, 31.5, 120]],
  TA: [[-37.1, -12.3, 450]], // Tristan + Gough
  TC: [[21.8, -71.8, 150]],
  TD: [[15.5, 18.5, 800]],
  TG: [[8.6, 1, 300]],
  TH: [[15, 101, 700]],
  TJ: [[38.9, 71, 350]],
  TL: [[-8.8, 125.9, 200]],
  TM: [[39, 59, 600]],
  TN: [[34, 9.5, 400]],
  TO: [[-20, -175, 400]],
  TR: [[39, 35.5, 800]],
  TT: [[10.7, -61.2, 150]],
  TV: [[-8, 178.5, 300]],
  TW: [[23.7, 121, 250]],
  TZ: [[-6.5, 35, 600]],
  UA: [[49, 32, 650]],
  UG: [[1.3, 32.4, 300]],
  US: [[39, -97, 2300], [64, -152, 1300], [20.5, -157, 500],
       [13.5, 144.8, 400], [-14.3, -170.7, 300], [18.2, -66.5, 400]], // CONUS, AK, HI, Guam, Am. Samoa, PR/USVI
  UY: [[-32.8, -56, 400]],
  UZ: [[41.5, 64, 700]],
  VA: [[41.9, 12.45, 30]],
  VC: [[13.2, -61.2, 100]],
  VE: [[7.5, -66, 900]],
  VN: [[16, 107, 900]],
  VU: [[-16.5, 168, 500]],
  WF: [[-13.8, -177.5, 300]],
  WS: [[-13.7, -172.2, 200]],
  YE: [[15.5, 47.5, 800]], // incl. Socotra
  YT: [[-12.8, 45.15, 100]],
  ZA: [[-29, 25, 900], [-46.9, 37.7, 300]], // + Marion Is. (ZS8)
  ZM: [[-14.5, 27.5, 600]],
  ZW: [[-19, 29.8, 400]],
};

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Is this lat/lon a plausible location for a station of this country?
 * Fails OPEN: countries missing from the table are always plausible.
 */
export function latLonPlausibleForCountry(cc: string, latLon: [number, number]): boolean {
  const circles = REGIONS[cc.toUpperCase()];
  if (!circles) return true;
  return circles.some(
    ([lat, lon, r]) => haversineKm(lat, lon, latLon[0], latLon[1]) <= r + GEO_SLACK_KM,
  );
}

/** Countries covered by the plausibility table (for tests/audit). */
export function geoTableCountries(): string[] {
  return Object.keys(REGIONS);
}

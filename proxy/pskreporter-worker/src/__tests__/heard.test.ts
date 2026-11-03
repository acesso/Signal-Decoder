import { cleanCallsign, parseReports, upstreamUrl } from '../heard'

const XML = `<?xml version="1.0"?>
<receptionReports >
  <lastSequenceNumber value="74261989332"/>
  <receptionReport receiverCallsign="lu1abc" receiverLocator="GF05ab" senderCallsign="PU7FTW" senderLocator="HI22NU" frequency="21074916" flowStartSeconds="1793364465" mode="FT8" isSender="1" receiverDXCC="Argentina" receiverDXCCCode="LU" sNR="-21" />
  <receptionReport receiverCallsign="K1AA" receiverLocator="EM10" senderCallsign="PU7FTW" frequency="21074849" flowStartSeconds="1793364210" mode="FT8" receiverDXCC="United States &amp; co" />
  <receptionReport receiverCallsign="K2BB" senderCallsign="OTHER1" frequency="1" flowStartSeconds="1" mode="FT8" />
  <receptionReport receiverCallsign="K3CC" senderCallsign="PU7FTW" frequency="x" flowStartSeconds="1" mode="FT8" />
</receptionReports>`

test('reads the reports of the sender, skips others and malformed ones', () => {
  expect(parseReports(XML, 'PU7FTW')).toEqual([
    { rx: 'LU1ABC', grid: 'GF05ab', hz: 21074916, t: 1793364465, snr: -21, dxcc: 'Argentina', mode: 'FT8' },
    { rx: 'K1AA', grid: 'EM10', hz: 21074849, t: 1793364210, snr: null, dxcc: 'United States & co', mode: 'FT8' },
  ])
  expect(parseReports('<html>oops</html>', 'PU7FTW')).toEqual([])
})

test('callsigns are checked before anything is asked', () => {
  expect(cleanCallsign(' pu7ftw ')).toBe('PU7FTW')
  expect(cleanCallsign('PY2/K1AA')).toBe('PY2/K1AA')
  for (const bad of [null, '', 'AB', 'NODIGIT', 'K1AA&x=1', 'K1AA" onload', 'A'.repeat(17) + '1']) expect(cleanCallsign(bad)).toBeNull()
})

test('the upstream query asks for an hour of reception reports, with the contact only when set', () => {
  const u = new URL(upstreamUrl('PU7FTW', ''))
  expect(u.origin + u.pathname).toBe('https://retrieve.pskreporter.info/query')
  expect(Object.fromEntries(u.searchParams)).toEqual({ senderCallsign: 'PU7FTW', rronly: '1', flowStartSeconds: '-3600' })
  expect(new URL(upstreamUrl('PU7FTW', 'ops@example.org')).searchParams.get('appcontact')).toBe('ops@example.org')
})

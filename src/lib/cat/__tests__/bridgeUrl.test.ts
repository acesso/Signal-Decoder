// The bridge address field keeps ws:// but never /cat; /cat is added only
// for the CAT connection itself.
import { normalizeBridgeAddress, bridgeCatUrl } from '../bridgeUrl'

describe('bridge address', () => {
  it.each([
    ['192.168.0.13', 'ws://192.168.0.13'],
    ['usdx-bridge.local:8080', 'ws://usdx-bridge.local:8080'],
    ['http://192.168.0.10', 'ws://192.168.0.10'],
    ['https://bridge.example/', 'wss://bridge.example'],
    ['ws://192.168.0.10/cat', 'ws://192.168.0.10'],
    ['ws://192.168.0.10/', 'ws://192.168.0.10'],
    ['  ws://host/other  ', 'ws://host/other'],
    ['', ''],
  ])('field: %s -> %s', (input, expected) => {
    expect(normalizeBridgeAddress(input)).toBe(expected)
  })

  it.each([
    ['ws://192.168.0.13', 'ws://192.168.0.13/cat'],
    ['192.168.0.13', 'ws://192.168.0.13/cat'],
    ['ws://192.168.0.13/cat', 'ws://192.168.0.13/cat'],
    ['ws://host/other', 'ws://host/other'],
    ['', ''],
  ])('CAT URL: %s -> %s', (input, expected) => {
    expect(bridgeCatUrl(input)).toBe(expected)
  })
})

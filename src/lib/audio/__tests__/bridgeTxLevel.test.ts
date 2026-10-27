import { bridgeTxLevel, modeTxGain } from '../bridgeTxLevel'
import { txSink } from '../txSink'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('bridgeTxLevel', () => {
  const realFetch = global.fetch
  let posts: string[] = []
  beforeEach(() => {
    posts = []
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push(String(init.body)); return { ok: true, json: async () => ({}) } }
      if (String(url).startsWith('http://s3/')) return { ok: true, json: async () => ({ db: -20, muted: false }) }
      return { ok: false, json: async () => ({}) }   // a bridge without /dac-level
    }) as unknown as typeof fetch
  })
  afterAll(() => { global.fetch = realFetch })

  it('drives the DAC level only with TX on a bridge that has one', async () => {
    txSink.setKindAuto('speaker')
    bridgeTxLevel.attach('ws://s3')
    await flush()
    expect(bridgeTxLevel.db()).toBe(-20)
    expect(bridgeTxLevel.active()).toBe(false)   // TX on the sound card
    expect(modeTxGain(0.1)).toBe(0.1)

    txSink.setKindAuto('bridge')
    expect(bridgeTxLevel.active()).toBe(true)
    expect(modeTxGain(0.1)).toBe(1)              // the mode sends at full scale

    bridgeTxLevel.attach('ws://a1s')             // no /dac-level there
    await flush()
    expect(bridgeTxLevel.active()).toBe(false)
    expect(modeTxGain(0.1)).toBe(0.1)
  })

  it('clamps and debounces the POST', async () => {
    jest.useFakeTimers()
    bridgeTxLevel.attach('ws://s3')
    bridgeTxLevel.set(-12.4)
    bridgeTxLevel.set(-80)
    expect(bridgeTxLevel.db()).toBe(-60)
    jest.advanceTimersByTime(300)
    expect(posts).toEqual(['{"db":-60}'])
    jest.useRealTimers()
  })
})

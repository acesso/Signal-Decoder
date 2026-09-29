/**
 * Sends one IPFIX packet built by the real encoder to PSK Reporter and prints
 * what went on the wire.
 *
 * Point it at the test listener (14739) to have the server parse the packet and
 * publish its analysis at https://report.pskreporter.info/cgi-bin/psk-analysis.pl
 * without the spots reaching the live map. Port 4739 is the production ingest.
 *
 * Usage:
 *   node --experimental-strip-types scripts/pskreporter-test-send.ts [--port 14739] [--tcp|--udp]
 */
import net from 'node:net'
import dgram from 'node:dgram'
import { buildPskReporterPacket } from '../src/lib/ft/pskreporter/ipfix.ts'

const HOST = 'report.pskreporter.info'

const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 14739
const transport = argv.includes('--udp') ? 'udp' : 'tcp'

const nowWindow = Math.floor(Date.now() / 1000 / 15) * 15

const packet = buildPskReporterPacket({
  receiver: {
    callsign: 'ZZ9TEST',
    locator: 'GG60',
    decoderSoftware: 'Signal-Decoder 0.21.1',
  },
  spots: [
    { senderCallsign: 'PY2ABC', frequencyHz: 14074500, snrDb: -12, mode: 'FT8', locator: 'GG66', flowStartSeconds: nowWindow },
    { senderCallsign: 'K1ABC', frequencyHz: 14074820, snrDb: -21, mode: 'FT8', flowStartSeconds: nowWindow },
    { senderCallsign: 'JA1XYZ', frequencyHz: 7074300, snrDb: 3, mode: 'FT4', locator: 'PM95', flowStartSeconds: nowWindow },
  ],
  sequenceNumber: 1,
  sessionId: 0xdeadbeef,
})

function hexdump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const row = Array.from(bytes.subarray(i, i + 16))
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${i.toString(16).padStart(4, '0')}: ${hex.padEnd(47)}  ${ascii}`)
  }
  return lines.join('\n')
}

console.log(`${packet.length} bytes -> ${transport.toUpperCase()} ${HOST}:${port}\n`)
console.log(hexdump(packet))
console.log()

if (transport === 'udp') {
  const sock = dgram.createSocket('udp4')
  sock.send(packet, port, HOST, (err) => {
    console.log(err ? `send failed: ${err.message}` : 'sent')
    sock.close()
  })
} else {
  const sock = new net.Socket()
  sock.setTimeout(10_000)
  sock.connect(port, HOST, () => {
    sock.write(packet, () => {
      console.log('sent')
      setTimeout(() => sock.destroy(), 1000)
    })
  })
  sock.on('error', (err) => console.error(`send failed: ${err.message}`))
  sock.on('timeout', () => { console.error('timed out'); sock.destroy() })
}

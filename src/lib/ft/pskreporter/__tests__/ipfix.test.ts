import { buildPskReporterPacket, RECEIVER_TEMPLATE_ID, SENDER_TEMPLATE_ID } from '../ipfix';

const RECEIVER = {
  callsign: 'ZZ9TEST',
  locator: 'GG60',
  decoderSoftware: 'Signal-Decoder 0.21.1',
};

const SPOT = {
  senderCallsign: 'PY2ABC',
  frequencyHz: 14074500,
  snrDb: -12,
  mode: 'FT8',
  locator: 'GG66',
  flowStartSeconds: 1790000000,
};

function build(overrides: Partial<Parameters<typeof buildPskReporterPacket>[0]> = {}) {
  return buildPskReporterPacket({
    receiver: RECEIVER,
    spots: [SPOT],
    sequenceNumber: 1,
    sessionId: 0xdeadbeef,
    sentAtSeconds: 1790000015,
    ...overrides,
  });
}

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

/** Walks the set list the way a collector does. */
function sets(packet: Uint8Array): { id: number; length: number; at: number }[] {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const out = [];
  for (let at = 16; at < packet.length; ) {
    const id = view.getUint16(at);
    const length = view.getUint16(at + 2);
    out.push({ id, length, at });
    at += length;
  }
  return out;
}

describe('buildPskReporterPacket', () => {
  // Byte-for-byte lock on a packet this encoder actually sent to PSK Reporter's
  // test listener, which parsed every field without warnings. If this changes,
  // the wire format changed — re-verify against the listener before updating it.
  it('matches the packet the collector accepted', () => {
    const packet = build({
      spots: [
        SPOT,
        { senderCallsign: 'K1ABC', frequencyHz: 14074820, snrDb: -21, mode: 'FT8', flowStartSeconds: 1790000000 },
      ],
    });
    expect(hex(packet)).toBe(
      '000a00d86ab13b8f00000001deadbeef' +
      '000300249992000300018002ffff0000768f8004ffff0000768f8008ffff0000768f0000' +
      '00020044999300088001ffff0000768f800500040000768f800600010000768f800700010000768f' +
      '800affff0000768f800b00010000768f8003ffff0000768f00960004' +
      '99920028075a5a39544553540447473630155369676e616c2d4465636f64657220302e32312e3100' +
      '999300380650593241424300d6c284f400034654380104474736366ab13b80' +
      '054b3141424300d6c3c4eb000346543801006ab13b80000000',
    );
  });

  describe('message header', () => {
    it('is IPFIX v10 with a length matching the packet', () => {
      const packet = build();
      const view = new DataView(packet.buffer);
      expect(view.getUint16(0)).toBe(0x000a);
      expect(view.getUint16(2)).toBe(packet.length);
    });

    it('carries the send time, sequence number and session id', () => {
      const packet = build({ sequenceNumber: 7, sessionId: 0x12345678, sentAtSeconds: 1790000015 });
      const view = new DataView(packet.buffer);
      expect(view.getUint32(4)).toBe(1790000015);
      expect(view.getUint32(8)).toBe(7);
      expect(view.getUint32(12)).toBe(0x12345678);
    });
  });

  describe('templates', () => {
    it('declares enterprise fields as 8-byte specifiers carrying enterprise 30351', () => {
      // The 4-byte form is only legal for standard IEs. Getting this wrong makes
      // the collector read the next specifier as an enterprise number and walk
      // off the end of the template.
      const packet = build();
      const senderTemplate = sets(packet).find((s) => s.id === 0x0002)!;
      const view = new DataView(packet.buffer);
      let at = senderTemplate.at + 8; // set header + template id + field count
      for (let i = 0; i < 7; i++) {
        expect(view.getUint16(at) & 0x8000).toBe(0x8000);
        expect(view.getUint32(at + 4)).toBe(30351);
        at += 8;
      }
      // flowStartSeconds is IE 150, a standard element, so it uses the short form.
      expect(view.getUint16(at)).toBe(150);
      expect(view.getUint16(at + 2)).toBe(4);
    });

    it('uses an options template for the receiver and a plain template for senders', () => {
      const ids = sets(build()).map((s) => s.id);
      expect(ids).toEqual([0x0003, 0x0002, RECEIVER_TEMPLATE_ID, SENDER_TEMPLATE_ID]);
    });

    it('switches to the four-field receiver template when an antenna is given', () => {
      const withAntenna = build({ receiver: { ...RECEIVER, antenna: 'dipole @ 10m' } });
      const optionsTemplate = sets(withAntenna).find((s) => s.id === 0x0003)!;
      expect(new DataView(withAntenna.buffer).getUint16(optionsTemplate.at + 6)).toBe(4);
    });

    it('can be omitted once the collector has seen them', () => {
      const ids = sets(build({ includeTemplates: false })).map((s) => s.id);
      expect(ids).toEqual([RECEIVER_TEMPLATE_ID, SENDER_TEMPLATE_ID]);
    });
  });

  describe('sets', () => {
    it('pads every set to a four-byte boundary and covers the whole packet', () => {
      // Two records of odd length, so the sender set needs padding.
      const packet = build({
        spots: [SPOT, { senderCallsign: 'K1ABC', frequencyHz: 14074820, snrDb: -21, mode: 'FT8', flowStartSeconds: 1790000000 }],
      });
      const list = sets(packet);
      for (const s of list) expect(s.length % 4).toBe(0);
      const last = list[list.length - 1];
      expect(last.at + last.length).toBe(packet.length);
    });

    it('omits the sender set when there is nothing to report', () => {
      const ids = sets(build({ spots: [] })).map((s) => s.id);
      expect(ids).not.toContain(SENDER_TEMPLATE_ID);
    });
  });

  describe('field encoding', () => {
    it('writes strings as a length byte with no NUL terminator', () => {
      const packet = build();
      const receiverData = sets(packet).find((s) => s.id === RECEIVER_TEMPLATE_ID)!;
      expect(packet[receiverData.at + 4]).toBe(7);
      expect(new TextDecoder().decode(packet.subarray(receiverData.at + 5, receiverData.at + 12))).toBe('ZZ9TEST');
      expect(packet[receiverData.at + 12]).toBe(4); // next length byte, not a NUL
    });

    it('encodes a missing locator as a zero-length string', () => {
      const packet = build({ spots: [{ ...SPOT, locator: undefined }] });
      expect(hex(packet)).toContain('0100'); // informationSource=1 followed by an empty locator
    });

    it('encodes negative SNR as a signed byte', () => {
      const packet = build({ spots: [{ ...SPOT, snrDb: -12 }] });
      const senderData = sets(packet).find((s) => s.id === SENDER_TEMPLATE_ID)!;
      // callsign (1 + 6) then frequency (4), so SNR sits 11 bytes into the record.
      expect(new DataView(packet.buffer).getInt8(senderData.at + 4 + 11)).toBe(-12);
    });

    it('clamps SNR to a signed byte and defaults a missing one to zero', () => {
      const offset = 4 + 11;
      const clamped = build({ spots: [{ ...SPOT, snrDb: 999 }] });
      const senderData = sets(clamped).find((s) => s.id === SENDER_TEMPLATE_ID)!;
      expect(new DataView(clamped.buffer).getInt8(senderData.at + offset)).toBe(127);

      const missing = build({ spots: [{ ...SPOT, snrDb: undefined }] });
      expect(new DataView(missing.buffer).getInt8(senderData.at + offset)).toBe(0);
    });

    it('truncates a string that will not fit in a length byte', () => {
      const packet = build({ receiver: { ...RECEIVER, decoderSoftware: 'x'.repeat(300) } });
      const receiverData = sets(packet).find((s) => s.id === RECEIVER_TEMPLATE_ID)!;
      // callsign (1 + 7) and locator (1 + 4) precede it.
      expect(packet[receiverData.at + 4 + 8 + 5]).toBe(254);
    });
  });
});

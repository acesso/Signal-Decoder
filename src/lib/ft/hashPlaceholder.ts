// An unresolved hashed callsign in a decoded message: a station whose call
// was sent as a hash (a compound call, or a Fox in DXpedition mode) that the
// decoder has not yet seen spelled out. Every part of this app writes it
// "<...>". ft8mon (lib/ft8mon/unpack.cc) writes it with the hash's size in
// bits instead, "<...22>" or "<...12>" (ft8_lib and ft8ts already write
// "<...>"); decodeWithFt8Mon's output goes through this so a "<...22> R2SL KO94"
// is read like any other message with an unknown hashed call.
//
// ft8mon also writes each standard callsign as its packed 6-character field,
// spaces kept: "W4PSK" comes out " W4PSK", the message " W4PSK PU7FTW HI22".
// The spaces vanish on screen but not in comparisons (my own TX recorded as
// sent never matched its decode), so the message's spacing is made single.
export const standardHashPlaceholders = (msg: string): string =>
  msg.replace(/<\.\.\.\d+>/g, '<...>').trim().replace(/\s+/g, ' ')

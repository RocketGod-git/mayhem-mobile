/**
 * WIRES-X replies a node sends to a radio over Fusion (not in Yaesu's published specification; the layout is from
 * the YSFClients gateway, see the credits). They travel as data full rate frames (DT 1): the data units after CSD3,
 * read in order, hold a sequence number, then 5D xx 5F 26 (xx: 51 the node's own information, 41 connected to a room
 * or disconnected, 46 a list), the node's 5-digit ID, its callsign (10), its name (14), two status characters, and
 * when connected the room's 5-digit ID, its name (16), its user count (3, from byte 57) and description (14, from
 * byte 70). A 0x03 byte ends the data, and the byte after it is the sum of all the bytes before it. No DOM.
 */
import { asciiField } from './fec.js';

export interface WiresX { kind: 'node' | 'connect' | 'disconnect' | 'list'; nodeId: string; node: string; name: string; roomId: string; room: string; count: string; description: string }

/** The data units of a reply, joined → the reply, or null when they do not hold a whole one with a good sum. */
export function wiresxReply(b: ArrayLike<number>): WiresX | null {
  if (b.length < 36 || b[1] !== 0x5d || b[3] !== 0x5f || b[4] !== 0x26) return null;
  const cmd = b[2];
  if (cmd !== 0x51 && cmd !== 0x41 && cmd !== 0x46) return null;
  // the end marker: the first 0x03 at or after the fixed fields whose next byte is the sum of all before it
  let sumOk = false;
  for (let e = 36, sum = Array.from({ length: 36 }, (_, i) => b[i] & 255).reduce((a, x) => a + x, 0); e + 1 < b.length; e++) {
    sum += b[e] & 255;
    if ((b[e] & 255) === 0x03 && (sum & 255) === (b[e + 1] & 255)) { sumOk = true; break; }
  }
  if (!sumOk) return null;
  const inRoom = b[35] === 0x33 && b.length >= 84;          // status '3': connected
  const kind = cmd === 0x51 ? 'node' : cmd === 0x46 ? 'list' : inRoom ? 'connect' : 'disconnect';
  return {
    kind, nodeId: asciiField(b, 5, 5), node: asciiField(b, 10, 10), name: asciiField(b, 20, 14),
    roomId: inRoom ? asciiField(b, 36, 5) : '', room: inRoom ? asciiField(b, 41, 16) : '', count: inRoom ? asciiField(b, 57, 3) : '', description: inRoom ? asciiField(b, 70, 14) : '',
  };
}

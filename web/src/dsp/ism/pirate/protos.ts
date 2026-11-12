/**
 * ProtoPirate's protocol catalog (protocols/protocol_items.c): which decoders listen behind AM (OOK) and which behind
 * FM (2-FSK). Protocols ProtoPirate routes by the preset's modulation run behind both, one instance each. Twin of
 * pirate/PPProtos.kt.
 */
import type { PPDecoder } from './pp-base.js';
import { PPChryslerV0 } from './chrysler-v0.js';
import { PPFiatV0 } from './fiat-v0.js';
import { PPFiatV1 } from './fiat-v1.js';
import { PPFiatV2 } from './fiat-v2.js';
import { PPFordV0 } from './ford-v0.js';
import { PPFordV1 } from './ford-v1.js';
import { PPFordV2 } from './ford-v2.js';
import { PPFordV3 } from './ford-v3.js';
import { PPHondaStatic } from './honda-static.js';
import { PPHondaV1 } from './honda-v1.js';
import { PPHondaV2 } from './honda-v2.js';
import { PPKiaV0 } from './kia-v0.js';
import { PPKiaV1 } from './kia-v1.js';
import { PPKiaV2 } from './kia-v2.js';
import { PPKiaV3V4 } from './kia-v3v4.js';
import { PPKiaV5 } from './kia-v5.js';
import { PPKiaV6 } from './kia-v6.js';
import { PPKiaV7 } from './kia-v7.js';
import { PPLandRoverFsk } from './land-rover-fsk.js';
import { PPMazdaV0 } from './mazda-v0.js';
import { PPPsa } from './psa.js';
import { PPRenaultV0 } from './renault-v0.js';
import { PPRenaultV1 } from './renault-v1.js';
import { PPScherKhan } from './scher-khan.js';
import { PPStarLine } from './star-line.js';
import { PPSubaru } from './subaru.js';
import { PPVag } from './vag.js';

/** Fresh decoders: the AM set and the FM set. */
export function ppAll(): { am: PPDecoder[]; fm: PPDecoder[] } {
  const am: PPDecoder[] = [new PPChryslerV0(), new PPFiatV0(), new PPFiatV1(), new PPFiatV2(), new PPFordV0(), new PPHondaV1(), new PPKiaV1(),
    new PPKiaV2(), new PPMazdaV0(), new PPPsa(), new PPRenaultV0(), new PPRenaultV1(), new PPStarLine(), new PPSubaru(), new PPVag()];
  const fm: PPDecoder[] = [new PPFordV1(), new PPFordV2(), new PPFordV3(), new PPHondaStatic(), new PPHondaV2(), new PPKiaV0(), new PPKiaV3V4(),
    new PPKiaV5(), new PPKiaV6(), new PPKiaV7(), new PPScherKhan(), new PPMazdaV0(), new PPPsa(), new PPRenaultV1(), new PPLandRoverFsk()];
  return { am, fm };
}

/**
 * The rtl_433 port: everything needed to hear a few hundred kinds of sensor, remote and tire valve.
 *
 * Import this and every protocol registers itself.
 */

export { BitBuffer, bitAt, BITBUF_COLS, BITBUF_ROWS } from './bitbuffer.js';
export { PulseDetect, PulseKind, type BurstFn } from './detect.js';
export { slice, type PulseData } from './slicers.js';
export { R433, type R433Result, type R433Stats } from './runner.js';
export {
  Modulation, REGISTRY, byNum, register,
  DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_OTHER, DECODE_FAIL_SANITY,
  type R433Data, type RDevice, type DecodeFn, type DecodeCtx,
} from './device.js';
export * as bits from './util.js';

export { R433Processor, protocolList, type HeardDevice, type R433Report, type R433Protocol } from './processor.js';
export { Baseband } from './baseband.js';
export { describeBurst, shapeSummary, type BurstShape, type Cluster } from './analyze.js';

import './devices/index.js';

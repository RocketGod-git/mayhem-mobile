/** The Analyzer: capture every burst, read it to bits, line repeats up, and hand it to the Devices decoders or a file. */
export { AnalyzerCapture, AnalyzerProcessor, captureFile, matchLabel, MAX_BURST_S, type Burst } from './capture.js';
export { analyze, bitsToAscii, bitsToHex, pulsesUs, signalOf, FM_SCALE, MODS, CODINGS, type Analysis, type Coding, type Frame, type Mod, type Overrides, type Run } from './demod.js';
export { align, bestShift, similar, type Alignment, type AlignedRow, type Segment } from './align.js';
export { exportName, freqFromName, fromIqFile, parseSub, rateFromName, subPreset, synthesize, toCs8, toCu8, toSub, type SubFile } from './files.js';

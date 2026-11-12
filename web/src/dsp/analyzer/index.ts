/** The Analyzer: capture every burst, read it to bits, line repeats up, and hand it to the Devices decoders or a file. */
export { AnalyzerCapture, AnalyzerProcessor, captureFile, matchLabel, passes, MAX_BURST_S, NO_FILTER, type Burst, type CaptureFilter } from './capture.js';
export { analyze, syncTrim, bitsToAscii, bitsToHex, decodeSpans, histogram, pulsesUs, signalOf, FM_SCALE, MODS, CODINGS, type Analysis, type Coding, type Frame, type Mod, type Overrides, type Run } from './demod.js';
export { align, bestShift, similar, type Alignment, type AlignedRow, type Segment } from './align.js';
export { BUNDLE_MAGIC, decodeBundle, encodeBundle, exportName, freqFromName, fromIqFile, parseSub, rateFromName, subPreset, synthesize, toCs8, toCu8, toSub, type BundleArrays, type SubFile } from './files.js';
export { bytesOf, checkHolds, checkOf, checkSpecs, dataStart, fieldValue, findCheck, findCounter, fromStart, recognize, specName, suggest, FIELD_KINDS, type CheckFound, type CheckSpec, type Field, type FieldKind, type Protocol } from './fields.js';
export { groupPresses, sameFrame, type GroupIn, type Transmission } from './group.js';
export { classCsv, classify, clockDrift, edgesOf, eyeStarts, frameSegments, framesCsv, levels, pulseCsv, pulseTable, samplesCsv, selectionCsv, symbolFit, type FrameSeg, type Levels, type Pulse, type PulseClass, type PulseTable } from './measure.js';

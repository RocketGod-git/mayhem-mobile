/** BCCH-DL-SCH decoding (36.331 system information) with the UPER decoder and the 36.331 subset. */
import { parseAsn1, Uper } from './uper.js';
import { RRC_ASN } from './rrc-asn.js';

let uper: Uper | null = null;
export function rrcDecoder(): Uper {
  if (!uper) uper = new Uper(parseAsn1(RRC_ASN));
  return uper;
}

export function decodeBcchDlSch(bytes: Uint8Array): { value: unknown; bitsUsed: number; error?: string } {
  try {
    const r = rrcDecoder().decode('BCCH-DL-SCH-Message', bytes);
    return { value: r.value, bitsUsed: r.bitsUsed };
  } catch (e) {
    return { value: null, bitsUsed: 0, error: (e as Error).message };
  }
}

/** The SIB1 or the SIB list carried by one decoded BCCH-DL-SCH message. */
export function messageParts(value: unknown): { sib1?: Record<string, unknown>; sibs: [string, Record<string, unknown>][] } {
  const c1 = ((value as Record<string, Record<string, unknown>> | null)?.message?.c1 ?? null) as Record<string, unknown> | null;
  if (!c1) return { sibs: [] };
  if (c1.systemInformationBlockType1) return { sib1: c1.systemInformationBlockType1 as Record<string, unknown>, sibs: [] };
  const ce = (c1.systemInformation as Record<string, Record<string, unknown>> | undefined)?.criticalExtensions;
  const list = ((ce?.['systemInformation-r8'] as Record<string, unknown> | undefined)?.['sib-TypeAndInfo'] ?? []) as Record<string, unknown>[];
  return { sibs: list.map(x => { const k = Object.keys(x)[0]; return [k, x[k] as Record<string, unknown>]; }) };
}

export function hexToBytes(hex: string): Uint8Array {
  const o = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return o;
}

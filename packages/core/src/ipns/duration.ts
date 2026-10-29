const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a Kubo-style duration string (e.g. `"10s"`, `"1h30m"`, `"500ms"`)
 * into milliseconds, which is what Helia's IPNS options expect.
 */
export function parseDurationMs(value: string): number {
  const trimmed = value.trim();
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trimmed)) !== null) {
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
    consumed = pattern.lastIndex;
  }
  if (trimmed === '' || consumed !== trimmed.length) {
    throw new Error(`Invalid duration "${value}" — expected e.g. "10s", "5m", "24h"`);
  }
  return total;
}

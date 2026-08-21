/**
 * Version comparison for the harness-update pipeline: compare a descriptor's
 * `verifiedAgainst` against the latest published version to decide whether
 * the descriptor's facts are stale. Pure and dotted-numeric: prerelease and
 * build suffixes are split on and compared numerically where present, else
 * ignored - the signal is "a newer version shipped", not full semver
 * precedence.
 */

export type VersionStatus = "ok" | "behind" | "ahead" | "unknown" | "drift";

const parse = (v: string): number[] =>
  v
    .trim()
    .split(/[.\-+]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => !Number.isNaN(n));

/** -1 if a < b, 0 if equal, 1 if a > b, comparing dotted-numeric parts with
 * missing trailing parts treated as 0. */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 => {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

/** Where `verified` stands relative to `latest`. `unknown` when either is
 * absent or has no numeric parts (so a wrong descriptor never reads as ok). */
export const versionStatus = (verified: string, latest: string | null): VersionStatus => {
  if (latest === null) return "unknown";
  if (parse(verified).length === 0 || parse(latest).length === 0) return "unknown";
  const cmp = compareVersions(verified, latest);
  if (cmp < 0) return "behind"; // a newer version has shipped - descriptor unverified for it
  if (cmp > 0) return "ahead"; // verified newer than the published latest (unexpected)
  return "ok";
};

/**
 * resumeLast corroboration (the codex --last race): given the candidate
 * sessions a store scan produced, rank them by evidence and choose only
 * when the evidence actually distinguishes them. Two candidates the
 * ranking cannot tell apart is a refusal the caller must surface - "most
 * recent" over a race window is a guess, and a guess resumes a stranger.
 *
 * cwd corroboration compares path STRINGS (trailing slashes normalized);
 * canonicalization (symlinks, /tmp vs /private/tmp) is the caller's job at
 * the impure boundary - harnesses record resolved paths, so pass resolved
 * paths in.
 */

export interface ResumeCandidate {
  readonly id: string;
  readonly mtimeMs: number;
  readonly cwd: string;
}

export type ResumeLastVerdict =
  | { readonly kind: "chosen"; readonly id: string; readonly ranked: readonly string[] }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[]; readonly reason: string }
  | { readonly kind: "none" };

/** Two same-tier candidates whose mtimes are closer than this cannot be
 * distinguished by recency - filesystem timestamps race at this scale. */
const RECENCY_EPSILON_MS = 2_000;

const normalizePath = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export const rankResumeLast = (
  candidates: readonly ResumeCandidate[],
  context: { readonly cwd: string },
): ResumeLastVerdict => {
  const cwd = normalizePath(context.cwd);

  // A store scan can surface one session twice (rotated file, symlinked
  // root); duplicates are one candidate, not an ambiguity. Keep the best
  // evidence per id: cwd match wins, then the newest mtime.
  const byId = new Map<string, ResumeCandidate>();
  for (const candidate of candidates) {
    const held = byId.get(candidate.id);
    if (held === undefined) {
      byId.set(candidate.id, candidate);
      continue;
    }
    const heldMatch = normalizePath(held.cwd) === cwd;
    const nextMatch = normalizePath(candidate.cwd) === cwd;
    if (
      (nextMatch && !heldMatch) ||
      (nextMatch === heldMatch && candidate.mtimeMs > held.mtimeMs)
    ) {
      byId.set(candidate.id, candidate);
    }
  }

  const unique = [...byId.values()];
  if (unique.length === 0) return { kind: "none" };

  const tierOf = (c: ResumeCandidate): number => (normalizePath(c.cwd) === cwd ? 0 : 1);
  const ranked = unique.sort((x, y) => {
    const tier = tierOf(x) - tierOf(y);
    if (tier !== 0) return tier;
    return y.mtimeMs - x.mtimeMs;
  });

  const first = ranked[0];
  if (first === undefined) return { kind: "none" };
  if (!Number.isFinite(first.mtimeMs)) {
    return {
      kind: "ambiguous",
      candidates: ranked.map((c) => c.id),
      reason: "candidate timestamps are unusable (non-finite mtime) - refusing to guess",
    };
  }

  // Every same-tier candidate within the epsilon of the winner is part of
  // the ambiguity - reporting only two of N hides contenders.
  const contenders = ranked.filter(
    (c) =>
      c !== first &&
      tierOf(c) === tierOf(first) &&
      (!Number.isFinite(c.mtimeMs) || Math.abs(first.mtimeMs - c.mtimeMs) < RECENCY_EPSILON_MS),
  );
  if (contenders.length > 0) {
    return {
      kind: "ambiguous",
      candidates: [first.id, ...contenders.map((c) => c.id)],
      reason: `${contenders.length + 1} candidates share the same corroboration tier within ${RECENCY_EPSILON_MS}ms - refusing to guess`,
    };
  }
  return { kind: "chosen", id: first.id, ranked: ranked.map((c) => c.id) };
};

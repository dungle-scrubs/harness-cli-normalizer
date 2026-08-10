/**
 * resumeLast corroboration (the codex --last race): given the candidate
 * sessions a store scan produced, rank them by evidence and choose only
 * when the evidence actually distinguishes them. Two candidates the
 * ranking cannot tell apart is a refusal the caller must surface - "most
 * recent" over a race window is a guess, and a guess resumes a stranger.
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

export const rankResumeLast = (
  candidates: readonly ResumeCandidate[],
  context: { readonly cwd: string },
): ResumeLastVerdict => {
  if (candidates.length === 0) return { kind: "none" };
  const ranked = [...candidates].sort((x, y) => {
    const xCwd = x.cwd === context.cwd ? 0 : 1;
    const yCwd = y.cwd === context.cwd ? 0 : 1;
    if (xCwd !== yCwd) return xCwd - yCwd;
    return y.mtimeMs - x.mtimeMs;
  });
  const [first, second] = ranked;
  if (first === undefined) return { kind: "none" };
  if (
    second !== undefined &&
    (first.cwd === context.cwd) === (second.cwd === context.cwd) &&
    Math.abs(first.mtimeMs - second.mtimeMs) < RECENCY_EPSILON_MS
  ) {
    return {
      kind: "ambiguous",
      candidates: [first.id, second.id],
      reason: `two candidates share the same corroboration tier within ${RECENCY_EPSILON_MS}ms - refusing to guess`,
    };
  }
  return { kind: "chosen", id: first.id, ranked: ranked.map((c) => c.id) };
};

import type { Reference, Relation } from "../../knowledge/transcript/wire.js";

export function unknownRelation(): Relation {
  return { basis: "unknown", originalPaths: [], ruleId: null, state: "unknown", targets: [] };
}

export function nativeReference(
  kind: Reference["kind"],
  nativeId: string,
  scope: Reference["scope"],
): Reference {
  return { kind, nativeId, position: null, scope };
}

export function nativeRelation(
  target: Reference | null,
  originalPath: readonly (string | number)[],
): Relation {
  return target
    ? {
        basis: "native-field",
        originalPaths: [originalPath],
        ruleId: null,
        state: "known",
        targets: [target],
      }
    : unknownRelation();
}

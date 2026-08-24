/**
 * Version lookup shared by the harness-update scripts: the latest published
 * version of each harness (npm registry, or the local binary for `installed`
 * sources such as muse), the locally installed version, and the status of
 * `verifiedAgainst` relative to both.
 *
 * Consumers: check-versions (report only), check-harnesses (report plus
 * live re-verification), smoke-questions (installed version for provenance).
 */
import { execFileSync } from "node:child_process";
import { type VersionStatus, versionStatus } from "../../src/interpretation/versions.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";

export interface VersionRow {
  harness: string;
  bin: string;
  verifiedAgainst: string;
  latest: string | null;
  source: string;
  status: VersionStatus;
  installed: string | null;
}

export const npmLatest = async (pkg: string): Promise<string | null> => {
  try {
    // The packument (not the /latest tag endpoint, which does not route for
    // scoped names); the abbreviated form still carries dist-tags.
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
};

export const installedVersion = (bin: string): string | null => {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const match = out.match(/\d+\.\d+\.\d+(?:[.\-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};

const resolveLatest = async (
  h: HarnessDescriptor,
): Promise<{ latest: string | null; source: string }> => {
  if (h.versionSource.kind === "npm") {
    return {
      latest: await npmLatest(h.versionSource.package),
      source: `npm:${h.versionSource.package}`,
    };
  }
  return { latest: installedVersion(h.bin), source: `installed:${h.bin}` };
};

/** One row per descriptor. `drift` means the installed CLI differs from
 * `verifiedAgainst` while the published latest does not; `behind` means a
 * newer version shipped, whether or not it is installed. */
export const collectVersionRows = (
  descriptors: readonly HarnessDescriptor[],
): Promise<VersionRow[]> =>
  Promise.all(
    descriptors.map(async (h) => {
      const { latest, source } = await resolveLatest(h);
      const installed = installedVersion(h.bin);
      let status = versionStatus(h.verifiedAgainst, latest);
      if (installed !== null && installed !== h.verifiedAgainst && status !== "behind") {
        status = "drift";
      }
      return {
        harness: h.name,
        bin: h.bin,
        verifiedAgainst: h.verifiedAgainst,
        latest,
        source,
        status,
        installed,
      };
    }),
  );

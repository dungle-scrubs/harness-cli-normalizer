import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";

export const ls = (): void => {
  const descriptors = Object.values(defaultDescriptors()).filter(
    (d): d is HarnessDescriptor => d !== undefined,
  );
  for (const h of descriptors) {
    const source =
      h.versionSource.kind === "npm" ? `npm:${h.versionSource.package}` : `installed:${h.bin}`;
    // Format: "claude@2.1.229 (npm:@anthropic-ai/claude-code)"
    process.stdout.write(`${h.name}@${h.verifiedAgainst} (${source})\n`);
  }
};

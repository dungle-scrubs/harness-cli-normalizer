/**
 * Resume-last warning text (RFC-06 Safety item 4): rendered purely from
 * the descriptor's `resumeLast.warning` template, with the realpath scope
 * substituted for `{cwd}`. No harness-name branch - the per-harness
 * wording lives in the knowledge layer as data, and the CLI layer calls
 * this before spawn and hands the rendered line to the runner as data.
 */
import type { HarnessDescriptor } from "../knowledge/descriptor.js";

/** One fixed pre-spawn text carrying no id (the resumed id is known only
 * at the first stream announce). Verbatim per the RFC; pinned in tests. */
export const resumeLastWarning = (h: HarnessDescriptor, cwd: string): string => {
  const template = h.resumeLast?.warning;
  if (template === undefined) throw new Error(`harness ${h.name} has no resume-last warning`);
  return template.replaceAll("{cwd}", () => cwd);
};

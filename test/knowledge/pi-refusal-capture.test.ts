import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const capture = readFileSync(
  new URL("../fixtures/harnesses/pi-context-refused.ndjson", import.meta.url),
  "utf8",
);

// Pi repeats a message's sections inside aggregates such as `agent_end.messages`,
// so every `sections.docs` at any depth must carry the marker, not only the top level.
function collectSectionsDocs(value: unknown, found: unknown[]): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collectSectionsDocs(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "sections" && child !== null && typeof child === "object" && "docs" in child) {
        found.push(child.docs);
      }
      collectSectionsDocs(child, found);
    }
  }
  return found;
}

test("pi's context-refusal capture redacts every copy of the operator's docs section", () => {
  const docs = capture
    .trim()
    .split("\n")
    .flatMap((line) => collectSectionsDocs(JSON.parse(line), []));
  expect(docs).toEqual([
    "<redacted: operator agent configuration (docs), 1328 chars>",
    "<redacted: operator agent configuration (docs), 1328 chars>",
    "<redacted: operator agent configuration (docs), 1328 chars>",
  ]);
});

import { describe, expect, it } from "vitest";
import { canonicalNames, canonicalToolTable } from "../../src/interpretation/tool-vocabulary.js";
import { defaultDescriptors } from "../../src/knowledge/overrides.js";

describe("tool vocabulary", () => {
  it("canonicalNames is sorted eleven", () => {
    const names = canonicalNames(defaultDescriptors());
    expect(names).toEqual([
      "edit",
      "glob",
      "grep",
      "list",
      "read",
      "shell",
      "skill",
      "subagent",
      "web-fetch",
      "web-search",
      "write",
    ]);
  });

  it("table built from defaultDescriptors equals spec table per harness", () => {
    const table = canonicalToolTable(defaultDescriptors());
    const expectEntry = (canonical: string, expected: Record<string, unknown>) => {
      const entry = table[canonical] as Record<string, unknown>;
      expect(entry, `missing canonical ${canonical}`).toBeDefined();
      for (const [harness, val] of Object.entries(expected)) {
        expect(entry[harness], `${canonical} -> ${harness}`).toEqual(val);
      }
      for (const [harness, val] of Object.entries(entry)) {
        expect(
          expected[harness],
          `unexpected ${canonical} -> ${harness} = ${JSON.stringify(val)}`,
        ).toEqual(val);
      }
    };

    expectEntry("read", { claude: "Read", pi: "read" });
    expectEntry("write", { claude: "Write", pi: "write", muse: { category: "write" } });
    expectEntry("edit", { claude: "Edit", pi: "edit", muse: { category: "write" } });
    expectEntry("shell", { claude: "Bash", pi: "bash", muse: { category: "shell" } });
    expectEntry("grep", { claude: "Grep", pi: "grep" });
    expectEntry("glob", { claude: "Glob", pi: "find" });
    expectEntry("list", { pi: "ls" });
    expectEntry("web-fetch", { claude: "WebFetch", muse: { category: "web" } });
    expectEntry("web-search", { claude: "WebSearch", muse: { category: "web" } });
    expectEntry("subagent", { claude: "Task" });
    expectEntry("skill", { claude: "Skill" });

    expect(Object.keys(table).length).toBe(11);
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalNames,
  canonicalToolTable,
  mergeToolMaps,
} from "../../src/interpretation/tool-vocabulary.js";
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

    expectEntry("read", {
      claude: { kind: "builtin", native: "Read" },
      pi: { kind: "builtin", native: "read" },
    });
    expectEntry("write", {
      claude: { kind: "builtin", native: "Write" },
      pi: { kind: "builtin", native: "write" },
      muse: { kind: "category", key: "write" },
    });
    expectEntry("edit", {
      claude: { kind: "builtin", native: "Edit" },
      pi: { kind: "builtin", native: "edit" },
      muse: { kind: "category", key: "write" },
    });
    expectEntry("shell", {
      claude: { kind: "builtin", native: "Bash" },
      pi: { kind: "builtin", native: "bash" },
      muse: { kind: "category", key: "shell" },
    });
    expectEntry("grep", {
      claude: { kind: "builtin", native: "Grep" },
      pi: { kind: "builtin", native: "grep" },
    });
    expectEntry("glob", {
      claude: { kind: "builtin", native: "Glob" },
      pi: { kind: "builtin", native: "find" },
    });
    expectEntry("list", { pi: { kind: "builtin", native: "ls" } });
    expectEntry("web-fetch", {
      claude: { kind: "builtin", native: "WebFetch" },
      muse: { kind: "category", key: "web" },
    });
    expectEntry("web-search", {
      claude: { kind: "builtin", native: "WebSearch" },
      muse: { kind: "category", key: "web" },
    });
    expectEntry("subagent", { claude: { kind: "builtin", native: "Task" } });
    expectEntry("skill", { claude: { kind: "builtin", native: "Skill" } });

    expect(Object.keys(table).length).toBe(11);
  });
});

describe("mergeToolMaps", () => {
  it("user adds pi.web-search, project adds pi.subagent, both survive", () => {
    const { merged, tiers } = mergeToolMaps({
      user: { pi: { "web-search": "web_search" } },
      project: { pi: { subagent: "background_task" } },
    });
    expect(merged.pi?.["web-search"]).toBe("web_search");
    expect(merged.pi?.subagent).toBe("background_task");
    expect(tiers.pi?.["web-search"]).toBe("user-config");
    expect(tiers.pi?.subagent).toBe("project-config");
  });

  it("project overrides user on same key with tier project-config", () => {
    const { merged, tiers } = mergeToolMaps({
      user: { pi: { "web-search": "web_search" } },
      project: { pi: { "web-search": "other_search" } },
    });
    expect(merged.pi?.["web-search"]).toBe("other_search");
    expect(tiers.pi?.["web-search"]).toBe("project-config");
  });
});

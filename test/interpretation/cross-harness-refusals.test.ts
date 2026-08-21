import { describe, expect, test } from "vitest";
import { ArgvRefusalError } from "../../src/interpretation/refusal.js";
import { renderToolSelection } from "../../src/interpretation/tool-selection.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { piCli } from "../../src/knowledge/pi.js";

const refusalOf = (fn: () => unknown): ArgvRefusalError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArgvRefusalError) return e;
    throw e;
  }
  throw new Error("expected an ArgvRefusalError");
};

describe("cross-harness tool names refuse instead of passing through", () => {
  test("claude spellings on pi refuse and list the canonical set", () => {
    const err = refusalOf(() => renderToolSelection(piCli, { include: ["Read", "Grep"] }));
    expect(err.issue).toBe("unknown-tool-name");
    expect(err.harness).toBe("pi");
    expect(err.supported.join(",")).toContain("read");
    expect(err.supported.join(",")).toContain("grep");
  });

  test("pi spellings on claude refuse and list the canonical set", () => {
    const err = refusalOf(() => renderToolSelection(claudeCode, { include: ["find", "ls"] }));
    expect(err.issue).toBe("unknown-tool-name");
    expect(err.harness).toBe("claude");
    expect(err.supported.join(",")).toContain("glob");
    expect(err.supported.join(",")).toContain("list");
  });

  test("a mixed list refuses naming the bad name, not the good one", () => {
    const err = refusalOf(() => renderToolSelection(piCli, { include: ["read", "Grep"] }));
    expect(err.issue).toBe("unknown-tool-name");
    expect(err.message).toContain("Grep");
  });

  test("all-unmapped on claude refuses", () => {
    const err = refusalOf(() =>
      renderToolSelection(claudeCode, { include: ["Read", "Write", "Bash"] }),
    );
    expect(err.issue).toBe("unknown-tool-name");
  });

  test("all-unmapped on pi refuses", () => {
    const err = refusalOf(() => renderToolSelection(piCli, { include: ["bash", "edit", "ls"] }));
    expect(err.issue).toBe("unknown-tool-name");
  });
});

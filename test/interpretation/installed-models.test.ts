import { describe, expect, test } from "vitest";
import { installedModelPairs } from "../../src/interpretation/installed-models.js";

const custom = {
  providers: {
    lmstudio: { models: [{ id: "qwen3.6-35b-a3b-ud-mlx" }, { id: "qwen3.8-27b-mlx@8bit" }] },
    meta: { models: [{ id: "muse-spark-1.3-contributor" }] },
  },
};

const builtin = {
  zai: { models: [{ id: "glm-5.2" }, { id: "glm-5.3" }] },
  minimax: { models: [{ id: "MiniMax-M2.7" }] },
};

describe("installed pi model pairs", () => {
  test("both stores project to provider/model pairs", () => {
    expect(installedModelPairs({ custom, builtin })).toEqual([
      { provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx" },
      { provider: "lmstudio", model: "qwen3.8-27b-mlx@8bit" },
      { provider: "meta", model: "muse-spark-1.3-contributor" },
      { provider: "zai", model: "glm-5.2" },
      { provider: "zai", model: "glm-5.3" },
      { provider: "minimax", model: "MiniMax-M2.7" },
    ]);
  });

  test("a duplicate id under two providers stays two pairs", () => {
    const pairs = installedModelPairs({
      custom: { providers: { lmstudio: { models: [{ id: "shared" }] } } },
      builtin: { "lmstudio-mini": { models: [{ id: "shared" }] } },
    });
    expect(pairs).toEqual([
      { provider: "lmstudio", model: "shared" },
      { provider: "lmstudio-mini", model: "shared" },
    ]);
  });

  test("entries failing the selector shape are dropped silently", () => {
    const pairs = installedModelPairs({
      custom: {
        providers: {
          lmstudio: {
            models: [{ id: "good" }, { id: "has space" }, { id: "" }, "bare", null, {}],
          },
          "bad provider!": { models: [{ id: "nope" }] },
        },
      },
      builtin: null,
    });
    expect(pairs).toEqual([{ provider: "lmstudio", model: "good" }]);
  });

  test("a store of the wrong shape contributes nothing", () => {
    expect(installedModelPairs({ custom: null, builtin: null })).toEqual([]);
    expect(installedModelPairs({ custom: [], builtin: "text" })).toEqual([]);
    expect(installedModelPairs({ custom: { models: [] }, builtin: 42 })).toEqual([]);
    expect(installedModelPairs({ custom: { providers: null }, builtin: undefined })).toEqual([]);
  });

  test("credentials never enter the pairs", () => {
    const pairs = installedModelPairs({
      custom: {
        providers: {
          lmstudio: {
            apiKey: "lmstudio",
            models: [{ id: "qwen3.6-35b-a3b-ud-mlx", apiKey: "secret" }],
          },
        },
      },
      builtin: null,
    });
    expect(pairs).toEqual([{ provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx" }]);
    expect(JSON.stringify(pairs)).not.toContain("secret");
  });
});

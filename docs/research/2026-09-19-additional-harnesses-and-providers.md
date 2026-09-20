# Additional harnesses and model providers

Checked 2026-09-19. This is a documentation-based shortlist for Kevin's HCN
workflow. No candidate was installed or benchmarked. It is not a popularity
ranking or an implementation decision.

Standing: **documented** means the owning source states it; **observed** means
local files or command output were checked; **unverified** means no runtime
test established the claim. Priorities below are recommendations.

## Requested roadmap changes

**Observed:** ROADMAP.md now contains Junie CLI qualification and OpenCode Go
through Pi as a provider configuration. Grok Build remains listed with its
existing authentication blocker. These are planned work, not shipped support.
No other candidate was added to the roadmap.

## Candidates beyond the existing five harnesses

| Candidate | Documented distinction | Assessment for Kevin |
|---|---|---|
| Antigravity CLI | Google terminal agent with headless JSON/NDJSON output. Google's June announcement moved individual Gemini CLI users to Antigravity. | A useful missing native subscription route. Qualify the standalone CLI and its permissions before adding it. |
| GitHub Copilot CLI | Copilot-plan access, GitHub issue/PR operations, programmatic mode, custom agents and ACP. | Useful if Kevin wants the Copilot subscription and its native GitHub workflow. Existing harnesses with GitHub tools overlap substantially. |
| Factory Droid | Terminal agent with headless execution, structured output, custom Droids, and Missions. | Worth comparing on a real coding task for differences in execution quality. Its multi-agent workflow features overlap with caller responsibilities. |
| OpenCode | Configurable agents and permissions, language-server integration, CLI and server interfaces. | Worth comparing its code-navigation and editing behavior with Pi using the same model. Go subscription access alone does not require adding this harness. |
| Aider | Repository symbol map and architect/editor mode that separates proposed changes from file editing. | A distinct option for bounded code-editing tasks. Lower priority for the unattended general-purpose workflow. |

Sources, accessed 2026-09-19:

- Antigravity: [headless mode](https://www.antigravity.google/docs/cli/headless/),
  [Google's migration announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).
  The announcement preserves Gemini CLI access for enterprise Code Assist
  licenses and API-key authentication; it does not retire the entire CLI.
- Copilot: [overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli),
  [plan availability](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli).
- Droid: [overview](https://docs.factory.ai/droid-cli/overview),
  [CLI reference](https://docs.factory.ai/droid-cli/cli-reference).
- OpenCode: [agents and permissions](https://opencode.ai/docs/agents),
  [language servers](https://opencode.ai/docs/lsp/),
  [server](https://dev.opencode.ai/docs/server/).
- Aider: [repository map](https://aider.chat/docs/repomap.html),
  [chat modes](https://aider.chat/docs/usage/modes.html).

**Documented alternatives:** [Goose](https://block.github.io/goose/) provides a
general-purpose agent with CLI, desktop, API, and MCP extensions.
[Qwen Code](https://github.com/QwenLM/qwen-code/blob/main/docs/users/quickstart.md)
offers Alibaba and third-party provider connections. **Assessment:** Both have
substantial overlap with Kevin's current tools. Model availability alone does
not establish a gap that requires another HCN harness.

**Recommendation:** After the requested Junie and Go work, prioritize
Antigravity or Copilot when their subscriptions are useful. Evaluate Droid or
OpenCode when testing whether a different harness improves outcomes on the same
model. Compare completed-task cost, correctness, recovery, and tool behavior.
No claim of superior performance is established by this source review.

## Ollama subscription and CLI

**Documented:** Ollama has its own CLI for signing in and running models,
including cloud models. Its cloud service also accepts direct API requests
without a local Ollama installation. See [cloud access](https://docs.ollama.com/cloud)
and [CLI reference](https://docs.ollama.com/cli).

**Documented:** Ollama publishes a [Pi integration](https://docs.ollama.com/integrations/pi).
`ollama launch pi` installs Pi if needed, configures the provider and web tools,
and starts an interactive session. `ollama launch pi --config` configures the
integration without launching a session. A cloud model can be selected using
the launcher's model option. These commands were not executed here.

**Assessment:** For HCN coding work, Ollama fits as a model provider behind Pi
or another existing compatible coding harness. The Ollama CLI's model-running
function is different from the coding harness's file edits, shell execution,
and task loop. The launcher configures an external harness rather than proving
that Ollama itself supplies that harness behavior.

**Unverified:** The installed Pi/Ollama versions, authenticated subscription
usage, and HCN execution through that configuration have not been tested.
Ollama was not added to the roadmap because the user asked how it works, not
for that addition.

## Verification

The roadmap passes `git diff --check`. The installed HCN skill still describes
the existing five-harness CLI; planned additions require no shipped support
claim. Both `scripts/check-claims.sh` and `scripts/check-claims.test.sh` passed
from the source skill directory. Runtime code and skill files were unchanged.

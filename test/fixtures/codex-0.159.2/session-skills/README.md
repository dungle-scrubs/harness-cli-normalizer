# hcn session --skills on codex (issue #332)

Captured 2026-09-30 against installed `codex-cli 0.159.2` on the free local
route: isolated `CODEX_HOME=/tmp/codex-hcn332-home` holding only
`model = "qwen/qwen3.6-27b"` and `model_provider = "lmstudio"` (codex's
built-in lmstudio provider against the local LM Studio server; `wire_api =
"chat"` is rejected on 0.159.2, and `lmstudio` is a reserved built-in
provider id that cannot be overridden). No OpenAI quota was spent on this
capture; no operator MCP servers, hooks, or user config load under the
isolated home.

`skills-session.ndjson` is the full stdout of
`node dist/cli.js session codex --json --skills hcn --model qwen/qwen3.6-27b`
driven by a Node client (three `send` commands, each waited to its turn
`done`, then `close`): `session` opens - so app-server accepted the rendered
`-c skills.config=[...]` spawn token - all three sends report `disposition:
started`, all three turns end `done clean`, and `closed` ends the stream.
`skills-session.stderr.txt` carries the skills provenance line. The rendered
spawn argv is the same `buildSessionArgv` render the unit tests pin and the
same render `hcn run --skills` uses.

## The disable-set reaches served threads

Raw `codex app-server` runs the same day, same isolated home, model asked
"List every skill name visible to you":

- bare (no `-c`): the near-full discovered catalog (1password, aerospace,
  algolia, ... - 55 entries, alphabetically truncated by codex's catalog
  budget).
- with the exact rendered token for picks `[hcn]` (complement-off over the
  registry root): the list drops to the pick (`hcn`), codex's bundled skills
  (imagegen, openai-docs, skill-creator, skill-installer - `skills.bundled`
  is outside the render, per the descriptor note), and seven registry
  residues: docs, docx, import-memory, morning, pdf, pptx, xlsx.

The residue is the #209-adjacent limitation documented on the descriptor:
those names live in the registry's `synced/<uuid>/<name>` subtree, which
hcn's `known` list (top-level registry dirs) does not enumerate, so no
disable entry is rendered for them; their frontmatter names differ from no
basename hcn knows. The disable-set, the pick restatement, and the residue
are identical under `hcn run codex --skills` - the session render reuses the
one owner, so there is no session divergence here.

Deterministic cross-check on the exec surface (`codex debug prompt-input`,
no model calls): a single `-c skills.config=[{name="hcn", enabled=false}]`
removes hcn from the catalog; the full rendered token keeps hcn (pick
restated `enabled=true`) and removes the named complement entries.

Codex has no runtime skill tool either: "loading" means the model reading
`SKILL.md` with its file tools, so filesystem access bypasses the allowlist
exactly as on `hcn run` (documented semantics).

Secret scan at capture: no token/key/email content; the stream carries
model replies, session ids, and the provenance lines only.

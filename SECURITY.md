# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately - do **not** open a public
issue.

Use GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/dungle-scrubs/harness-cli-normalizer/security/advisories/new)**

Include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected versions, if known.

You should receive an initial response within a few days. Please do not
disclose the issue publicly until a fix has been released.

## Scope

This repository contains no secrets or credentials. The runtime itself does
not ship tokens; any harness CLI it drives is authenticated separately by the
end user. Out-of-scope: vulnerabilities in the upstream harness CLIs
(Claude Code, Codex, pi, Muse) - report those to their respective maintainers.

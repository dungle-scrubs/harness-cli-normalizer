# Raw `--` passthrough for harness-native flags

A bare `--` splits the command line: everything before it is hcn's normalized surface and refuses unknown flags, everything after it passes verbatim to the harness. A wrong-harness flag after `--` fails in the harness itself and surfaces as a native error (exit 1), never as an hcn refusal. Descriptor-validated passthrough that would refuse wrong-harness flags before spawn was considered and deferred; the raw split needs zero new descriptor data.


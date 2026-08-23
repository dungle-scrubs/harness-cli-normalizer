# Session input is a descriptor-owned closed kind with a pure encoder

The persistent-session input shape is declared in the descriptor as `sessionMode.input.kind` (closed union, today `claude-sdk-user-message`) and rendered by a pure function in `src/interpretation` that returns one newline-terminated record via `JSON.stringify`. The execution layer delegates to it and holds no harness-specific field names. The alternatives - an executable callback in the descriptor and a generic JSON-template language - were rejected to keep descriptors pure data and construction logic in interpretation.


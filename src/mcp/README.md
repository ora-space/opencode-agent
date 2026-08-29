# OpenCode MCP materialization

This module owns the OpenCode-specific half of Ora's MCP Configuration
Capability. It converts each complete protocol-v1 HTTP snapshot into the single
Workspace document `.opencode/opencode.json`; it does not merge with or modify
the project-root OpenCode configuration.

The materializer treats the generated document as an all-or-nothing managed
resource. A private plugin-storage ledger records both the last applied
fingerprint and a prepared operation before filesystem mutation. That evidence
allows an interrupted operation to be replayed without adopting a file merely
because it occupies the managed path. Root configuration collisions, tracked
files, Git exclude failures, permission failures, and fingerprint drift are
blocking preserved-state failures.

Filesystem staging, atomic replacement, permission restriction, Git inspection,
and ledger persistence are separate injectable ports. Production uses Deno and
Git implementations; tests substitute narrow failure implementations so cleanup
and previous-document preservation remain observable.

# Research: Command Artifact Linking

- **Decision**: Link only while a command is known active and cwd containment is unambiguous.
- **Rationale**: This preserves provenance without parsing shell syntax or mutating earlier evidence.
- **Alternative considered**: Parse `-o` and redirection arguments. Rejected because shell quoting, tool-specific flags, and files that were never written would create false evidence.

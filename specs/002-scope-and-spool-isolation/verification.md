# Verification: Scope and Spool Isolation

- Cross-project payloads remain byte-for-byte pending until their engagement
  opens.
- Payloads without complete engagement/operator identity are preserved as
  `.unattributed` and never assigned to the active project.
- A refused replay write remains pending; only an accepted write removes the
  source file.
- Focused spool replay tests: 4 passed.
- TypeScript typecheck passed.

The broader scope, filter, creation and immutable-ID behavior was verified by
the feature's original targeted, build and UI checks.

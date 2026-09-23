# Quickstart: One Scope Classifier

1. Put `target.com` in scope with warnings enabled.
2. Run `curl https://Dev.Target.com/admin` and confirm a scope warning.
3. Repeat with `dev.target.com:8443` and `dev.target.com.` and confirm the
   same warning.
4. Export with out-of-scope masking and confirm the same targets are masked as
   the investigation filter shows out of scope.
5. Configure exclusions only and confirm a non-excluded target is neither
   filtered out nor noticed.

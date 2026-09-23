# Quickstart: Alerts Without Correlation

1. Put a target in scope and trigger an IP exposure and an adjacent-scope hit
   close together; confirm an `ip_verdict` and a `scope_violation`, and no
   `combined_alert`.
2. Trigger ten adjacent-scope hits within a minute; confirm ten
   `scope_violation` events and no `burst_alert`.
3. Open a project that already holds `combined_alert` events; confirm they
   still display.

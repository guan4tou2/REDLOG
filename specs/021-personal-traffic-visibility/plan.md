# Implementation Plan: Personal Traffic Visibility

Extend the shared event filter with a display-only `hidePersonal` predicate.
Main attaches the active project's canonical `personalDomains`; persistence
queries resolve matching target IDs before limits. Timeline applies the same
canonical matcher to its loaded event set.

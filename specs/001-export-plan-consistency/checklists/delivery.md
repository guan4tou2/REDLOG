# Delivery Contract Checklist: Trustworthy Export Preview and Execution

**Purpose**: Review whether the requirements fully define a trustworthy, reviewable evidence-delivery contract
**Created**: 2026-09-19
**Feature**: [spec.md](../spec.md)

**Review Ownership**: Mark `[x]` only when a reviewer determines the requirements-quality criterion is satisfied. It does not mean implementation is complete.

## Requirement Completeness

- [ ] CHK001 Are selection requirements defined for every exposed format, including each format's intentionally narrower semantics? [Completeness, Spec §FR-014]
- [ ] CHK002 Are attachment inclusion, missing-file and unattributed-file requirements defined independently from Event counts? [Completeness, Spec §FR-004, §FR-011]
- [ ] CHK003 Are all sharing protections—scope, personal domains, blacklist, do-not-export and operator PII—named as distinct policies? [Completeness, Spec §FR-003]
- [ ] CHK004 Is the expected behavior for empty resolved selections defined for each artifact type? [Coverage, Spec §FR-008]

## Clarity and Consistency

- [ ] CHK005 Is “same resolved selection” defined precisely enough to compare preview, execution and manifest? [Clarity, Spec §FR-002]
- [ ] CHK006 Are “complete-event format” and “narrower contract” mapped to the five named formats? [Ambiguity, Spec §FR-005, §FR-014]
- [ ] CHK007 Are masking, sanitization, exclusion and unsupported behavior mutually distinguishable throughout the requirements? [Consistency, Spec §FR-004]
- [ ] CHK008 Is the relationship between dataset changes and policy/scope changes consistent between FR-007 and User Story 3? [Consistency, Spec §FR-007]

## Acceptance Criteria Quality

- [ ] CHK009 Can preview-to-artifact equality be measured separately for Events and Evidence attachments? [Measurability, Spec §SC-001, §SC-002]
- [ ] CHK010 Does every failure criterion define the observable absence of a false success state? [Measurability, Spec §FR-010, §FR-012, §SC-004]
- [ ] CHK011 Are the exact facts an operator must identify from confirmation enumerated? [Clarity, Spec §SC-005]

## Scenario and Edge Coverage

- [ ] CHK012 Are concurrent inserts, amendments, retention deletion, project switching and scope changes all assigned an explicit outcome? [Coverage, Spec §User Story 3, Edge Cases]
- [ ] CHK013 Are partial filesystem failures and missing Evidence recovery requirements defined without allowing a misleading complete artifact? [Exception Flow, Spec §Edge Cases]
- [ ] CHK014 Are preview expiry and application restart outcomes explicitly covered? [Gap]
- [ ] CHK015 Are keyboard, focus, loading and error-state requirements for the confirmation surface specified? [Gap, UX]
- [ ] CHK016 Are high-volume preview expectations quantified enough to validate responsiveness and memory use? [Gap, Non-Functional]

## Dependencies and Boundaries

- [ ] CHK017 Is the authority relationship between this feature and `docs/domain/SPEC-export-event-selection.md` explicit? [Dependency, Spec §Domain References]
- [ ] CHK018 Is legacy handler compatibility bounded so a partially migrated format cannot claim the new guarantee? [Assumption, Spec §FR-014]
- [ ] CHK019 Is single-use versus repeatable plan execution explicitly required? [Ambiguity]
- [ ] CHK020 Is the lifetime and invalidation boundary of an approved plan specified from the operator's perspective? [Gap]

## Notes

- `$speckit-implement` reads checklist state but does not modify markers.
- Add review findings inline and keep unresolved items unchecked.

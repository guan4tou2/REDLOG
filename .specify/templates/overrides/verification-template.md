# Verification: [FEATURE NAME]

<!-- The spec's **Status** line is the verdict; this file is the evidence for it.
     Record commands and counts, not adjectives. -->

## RED

<!-- The tests written first, and the reason each failed before the change.
     A low-risk copy or styling change (Constitution VIII) writes
     "Not required: <reason>". -->

## GREEN

<!-- The same tests passing after the change, then typecheck, the relevant
     integration suites, build and any affected desktop E2E journey. -->

## Operational Verification

<!-- Unit tests and typecheck cannot show that a capture source records, that
     a packaged build ships what it needs, or that an external API still
     dispatches the hook we implement. Two of the worst defects found so far
     passed every gate above:

       - exported bundles shipped without `redlog-verify.py`, because the
         packaged build did not carry it and nothing exercised a packaged build;
       - DNS capture recorded nothing for its whole life, because the addon
         implemented `dns_message` and mitmproxy dispatches `dns_request` /
         `dns_response`. The proxy answered queries correctly, so the only
         symptom was an empty timeline.

     Neither crashed. Both looked healthy. Tick only what was actually done,
     and name the evidence. -->

Risk surface: capture / packaging / external integration / none

- [ ] packaged build exercised
- [ ] real external dependency exercised (the actual binary, the actual version)
- [ ] first real event observed reaching the evidence store
- [ ] install / setup exercised
- [ ] uninstall / cleanup exercised, leaving nothing behind

Not applicable: <reason — e.g. "renderer-only visual change">

## Release Impact

<!-- main drifted 122 commits past the last release twice, with the CHANGELOG's
     Unreleased section holding two bullets. The product in git, the product a
     user downloads and the product the CHANGELOG describes were three
     different things. -->

| | |
|---|---|
| User-visible | yes / no |
| Breaking | yes / no |
| Packaging affected | yes / no |
| CHANGELOG updated | yes / no / n/a |
| Upgrade note required | yes / no |
| Packaged smoke required | yes / no |

<!-- User-visible = yes means a CHANGELOG entry before this spec is Verified.
     Packaging affected = yes means a packaged smoke, not a `npm run build`. -->

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | | |
| Checklist | | |
| Analyze | | |
| Converge | | |

<!-- Fill every row. Result says what happened: "no questions", "3 answered",
     "no findings", "2 tasks appended", or "not required: <reason>". Analyze, a
     question-free Clarify and a clean Converge leave no other trace, so an
     empty row reads as never run. -->

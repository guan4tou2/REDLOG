# Implementation Plan: Capture Browser Silence

## Canonical module interfaces

- `src/main/services/browser-launcher.ts`: `buildArgs` adds
  `--disable-field-trial-config`, disables `PreconnectToSearch` and the `Aim*`
  features, sets `--gaia-url` / `--gcm-checkin-url` to
  `*.redlog-offline.invalid` (`OFFLINE_SUFFIX`) and adds it to the proxy
  bypass list.

## Constitution Check

- **II. Surface Truthfulness**: the logged tier no longer holds traffic the
  operator never sent.
- **IX**: argument changes only; applies to RedLog's own profile, not the
  operator's browser.

# Feature Specification: Managed HTTP Capture

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

REDLOG already ships a mitmproxy addon and can launch a proxied browser, but
the operator must start `mitmdump` separately. That makes the primary web
evidence path look enabled while no process is listening. REDLOG will manage
that local process, expose its actual state, and route REDLOG-owned tools into
it.

## User Scenarios & Testing

### User Story 1 - Start HTTP capture with the project (Priority: P1)

As an operator, I need HTTP capture to become available without copying a
command into another terminal, so recording does not silently depend on a
forgotten process.

**Independent Test**: Open a project with `mitmdump` available and verify the
managed proxy reaches `running`; simulate a missing executable, occupied port,
and early process exit and verify each is an explicit non-running state.

### User Story 2 - Launch a browser only through live capture (Priority: P1)

As an operator, I need REDLOG's browser action to establish capture before the
browser opens, so "launched through proxy" is truthful.

**Independent Test**: Launch the REDLOG browser with the managed local proxy
stopped and verify capture starts first; if it cannot start, verify the browser
does not launch and the UI shows why.

### User Story 3 - Route REDLOG terminals consistently (Priority: P2)

As an operator, I need new built-in terminal panes to inherit the live proxy,
so proxy-aware tools such as curl and package clients enter the same HTTP log.

**Independent Test**: Spawn a terminal while capture is running and verify
uppercase and lowercase HTTP(S) proxy variables use the managed URL; spawn one
while capture is stopped and verify REDLOG does not inject stale variables.

## Requirements

- **FR-001**: REDLOG MUST own the lifecycle of one local regular-mode
  `mitmdump` process per open project.
- **FR-002**: Status MUST distinguish stopped, starting, running, unavailable,
  and failed states and MUST retain a useful failure reason.
- **FR-003**: Browser launch through the configured managed-local URL MUST wait
  for capture readiness and MUST fail closed when capture cannot start.
- **FR-004**: New built-in terminals MUST receive `HTTP_PROXY`, `HTTPS_PROXY`,
  `http_proxy`, and `https_proxy` only while the managed proxy is running.
- **FR-005**: Project close, project switch, and app quit MUST stop the owned
  process. REDLOG MUST NOT kill an external proxy it did not start.
- **FR-006**: The managed process MUST use the shipped
  `hooks/mitmproxy-addon.py`, preserving the existing event and provenance
  contract.
- **FR-007**: Manual external proxies and custom browser proxy URLs MUST remain
  usable; REDLOG only auto-manages loopback URLs matching its configured port.

## Out of Scope

- Transparent interception for tools that ignore proxy environment variables.
- Bundling the Python mitmproxy runtime into the application.
- Installing or trusting the mitmproxy CA in the operator's daily browser.
- DNS, TCP, UDP, SMB, LDAP, RDP, or C2 protocol capture.

## Success Criteria

- The browser cannot report a successful proxied launch while the managed
  local proxy is unavailable.
- A new built-in terminal has the four proxy variables exactly when capture is
  running.
- Every lifecycle failure is visible through IPC and the operator UI.

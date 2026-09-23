# Feature Specification: Managed HTTP Capture

**Feature Branch**: `feat/managed-http-capture`
**Created**: 2026-09-22
**Status**: Verified

REDLOG already ships a mitmproxy addon and can launch a proxied browser, but
the operator must start `mitmdump` separately. That makes the primary web
evidence path look enabled while no process is listening. REDLOG will manage
that local process, expose its actual state, and route REDLOG-owned tools into
it.

## User Scenarios & Testing

### User Story 1 - Start HTTP capture explicitly (Priority: P1)

As an operator, I need HTTP capture to become available without copying a
command into another terminal, so recording does not silently depend on a
forgotten process.

**Independent Test**: Open a project and verify capture stays stopped; explicitly start capture
and verify the managed proxy reaches `running`; simulate a missing executable, occupied port,
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
with terminal routing explicitly enabled, uppercase and lowercase HTTP(S)
proxy variables use the managed URL; spawn one
while capture is stopped and verify REDLOG does not inject stale variables.

## Requirements

- **FR-001**: Project opening MUST leave HTTP capture stopped. REDLOG MUST own the lifecycle of one local regular-mode
  `mitmdump` process per open project.
- **FR-002**: Status MUST distinguish stopped, starting, running, unavailable,
  and failed states and MUST retain a useful failure reason.
- **FR-003**: Browser launch through the configured managed-local URL MUST wait
  for capture readiness and MUST fail closed when capture cannot start.
- **FR-004**: New built-in terminals MUST receive `HTTP_PROXY`, `HTTPS_PROXY`,
  `http_proxy`, and `https_proxy` only while the managed proxy is running AND terminal routing is explicitly enabled
  (off by default).
- **FR-005**: Project close, project switch, and app quit MUST stop the owned
  process. REDLOG MUST NOT kill an external proxy it did not start.
- **FR-006**: The managed process MUST use the shipped
  `hooks/mitmproxy-addon.py`, preserving the existing event and provenance
  contract.
- **FR-007**: Manual external proxies and custom browser proxy URLs MUST remain
  usable; REDLOG only auto-manages loopback URLs matching its configured port.
- **FR-008**: Managed proxy port configuration MUST have one source of truth;
  changing it MUST restart an already running owned process (never start a stopped one) and route loopback browser and new
  terminal traffic to the new endpoint.
- **FR-009**: Capture Health MUST distinguish process readiness from traffic
  freshness, so a listening but unused proxy is not presented as contradictory.
- **FR-010**: REDLOG MUST expose whether mitmproxy's HTTPS CA exists and its
  path, but MUST NOT modify the operating-system trust store.
- **FR-011**: An owned proxy that exits unexpectedly MUST append a failure event
  to the active project and stop routing newly opened terminal panes to it.

## Out of Scope

- Transparent interception for tools that ignore proxy environment variables.
- Bundling the Python mitmproxy runtime into the application.
- Installing or trusting the mitmproxy CA in the operator's daily browser.
- DNS, TCP, UDP, SMB, LDAP, RDP, or C2 protocol capture.

## Success Criteria

- The browser cannot report a successful proxied launch while the managed
  local proxy is unavailable.
- A new built-in terminal has the four proxy variables exactly when capture is
  running and terminal routing is enabled.
- Every lifecycle failure is visible through IPC and the operator UI.

## Clarification — operator control (2026-09-22)

Opening a project MUST NOT start capture. Start HTTP capture and launching the
explicitly labelled capture browser are operator opt-ins. Terminal routing is
a separate project checkbox, applies only to new panes, and never rewrites
an already running shell.

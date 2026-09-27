# Decisions
- Append fresh `__redlog_verify` query token. Existing response events contain URL
  and status, so no new endpoint/service/addon contract is needed.
- Reject credentials, non-HTTP(S), controls and URLs over 4096 characters; strip
  fragments and retain ordinary query parameters. Replace prior test parameter.
- Exact URL equality prevents another URL carrying the same token from passing.
- Terminal recipe offers POSIX and PowerShell explicitly; host OS is only default.
- PID + proxy listener URL represent observable proxy identity. Poll and validate
  before accepting response; any status failure clears trust in previous results.
- TLS error bypass remains a browser setting; disclose it, never infer OS trust.

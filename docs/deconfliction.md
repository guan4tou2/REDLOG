# Deconfliction webhook

When a red team runs against an environment that has an active blue team, the moment a probe fires an alert the SOC has to answer one question: **"is this us, or is this real?"** Without a deconfliction feed, that takes phone calls and Slack pings. With one, it's an instant lookup.

RedLog can POST a signed JSON payload to a webhook you provide, for every event that matches your filter — typically `marker`, `scope_violation`, `credential_use`, and `c2_checkin`.

## When you should turn this on

- **Yes**: purple team, assumed-breach, or any engagement where the client's IR team is in the loop and expecting to be able to distinguish authorised traffic.
- **No**: covert external red team where the blue team is being tested on their detection response. A deconfliction webhook defeats the test.
- **N/A**: solo bug bounty, personal CTF, individual research.

The Rules of Engagement should say explicitly which side of this line the engagement is on.

## Configuration

Add to your project's `config.yaml` (or edit through the UI — TODO: settings panel):

```yaml
deconfliction:
  enabled: true
  url: "https://soc.client.example/hooks/redlog"
  secret: "shared-secret-from-blue-team"
  events:                 # forward events with these agent_type values
    - marker
    - credential_use
    - c2_checkin
    - system
  subtypes:               # also forward events with these subtype values
    - scope_violation
    # Since v0.6, RedLog also emits these system subtypes that are usually
    # worth forwarding to the SOC — uncomment as needed:
    # - ip_transition          # external IP or safety state (safe/exposed/unknown) changed
    # - opsec_state_changed    # VPN interfaces / DNS resolvers / MAC / hostname changed
    # - config_changed         # scope / blacklist / enforcement changed (with a from→to diff)
    # - recording_paused       # operator paused recording — explains any timeline gap
    # - recording_resumed
  includeData: false      # if true, include full event.data — mind PII
```

## Payload

```json
{
  "id": "8f4c4d1e-…",
  "timestamp": 1706400000000,
  "engagement_id": "client-pentest-q3",
  "operator_id": "codex-agent-a1b2c3",
  "agent_type": "credential_use",
  "target_id": "vpn.corp.example.com",
  "hostname": "op-laptop-01.local",
  "hash": "9f2c…",
  "subtype": "successful_login",
  "description": "Reused leaked svc-backup credentials to establish VPN tunnel",
  "severity": "high",
  "mitre_ttp": "T1078"
}
```

Header:

```
X-Redlog-Signature: sha256=<hex of HMAC-SHA256(secret, body)>
```

The blue team verifies by recomputing the HMAC with the shared secret. If it matches, the payload is authentic and they can close the ticket in seconds.

## Retry behaviour

If the webhook returns non-2xx or the connection fails, RedLog retries after 5s, 30s, then 120s. After the fourth attempt the notification is silently dropped — this is a best-effort feed, not a delivery-guaranteed queue. If reliability matters, front the webhook with something like a message queue.

## Test button

```bash
curl -X POST http://127.0.0.1:$PORT/api/deconfliction/test \
  -H "Authorization: Bearer $(redlog-cli token)"
# → { "ok": true, "status": 200 }
```

## Threat model

- **The secret is shared** with the blue team. Rotate it after each engagement.
- **HMAC-SHA-256** only proves that whoever sent the payload knew the secret at that moment. It does not prove non-repudiation — anyone with the secret could forge it.
- **Payload is not encrypted in transit** unless your webhook URL is HTTPS. Always use HTTPS.
- **PII / secret exposure** — with `includeData: true` the full event body ships to the blue team. Only enable if the blue team is authorised to see the same output your operators see.

## Related

- [Event schema](event-schema.md) — the standard keys that show up in `description` / `mitre_ttp` etc.
- [Audit trail](audit-trail.md) — the hash chain your `hash` field references
- [Operators](operators.md) — what `operator_id` maps to

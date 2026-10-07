import { describe, expect, it } from 'vitest'
import { scopeIssue } from '../src/renderer/src/lib/scopeIssue'

// The scope stat tile is gone, and these are the two of its four states that
// were conditions rather than numbers. The other two were a violation count,
// which the sidebar badge carries beside the page that opens it, and a green
// box that said there was nothing to say.

describe('scopeIssue', () => {
  it('says nothing while the first read is in flight', () => {
    // `configured` is false until the read lands, so without this a pending
    // counter appears at every launch and goes away a moment later.
    expect(scopeIssue({ loading: true, configured: false, unknown: false })).toBeNull()
    expect(scopeIssue({ loading: true, configured: false, unknown: true })).toBeNull()
  })

  it('says nothing once targets are declared', () => {
    expect(scopeIssue({ loading: false, configured: true, unknown: false })).toBeNull()
  })

  it('raises an undeclared scope as pending, not attention', () => {
    const s = scopeIssue({ loading: false, configured: false, unknown: false })
    expect(s?.tier).toBe('pending')
    expect(s?.titleKey).toBe('issues.scopeUnset')
    // Nothing to press: declaring targets is a page, not a button.
    expect(s?.fix).toBeUndefined()
  })

  it('raises a failed read as attention, with the read offered as the fix', () => {
    const s = scopeIssue({ loading: false, configured: false, unknown: true })
    expect(s?.tier).toBe('attention')
    expect(s?.fix).toBe('recheck-scope')
  })

  it('reports the failed read even when the scope is configured', () => {
    // "Configured" here is the value from a pair of reads, one of which
    // failed — so it is not an answer, and must not be shown as one.
    const s = scopeIssue({ loading: false, configured: true, unknown: true })
    expect(s?.titleKey).toBe('issues.scopeUnknown')
  })
})

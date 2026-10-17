import { LootDetector, withoutLeavingRulesStopped } from '../loot-detector'
import { getRules, redact, maskText } from '../redaction'
import { tagCommand } from '../command-tagger'
import { extractTargetWithProvenance } from '../target-extractor'

// "Would my rules do what I meant?" answered on pasted text, before a real
// session depends on it. Everything here is pure: the detector's findMatches
// (no dedup, no write), redaction's spans, the tag and target lookups. Nothing
// reaches the database, the event bus or the evidence chain.

/** A sample is a line or a short paste, not a file. */
export const TEST_SAMPLE_MAX_CHARS = 10_000

export interface SampleLootHit {
  type: string
  confidence: 'high' | 'medium' | 'low'
  /** false when the rule is switched off in this project: it still matches and
   *  its value is still masked, but live capture would not record it as loot */
  reported: boolean
  /** set for plugin rules; built-in rules carry no plugin attribution */
  pluginId?: string
  patternName?: string
}

export interface TestSampleResult {
  /** The text with everything redaction would mask replaced by •, so the
   *  result never shows a secret the sample contained. */
  masked: string
  maskedSpans: number
  loot: SampleLootHit[]
  target: { host: string | null; pluginId?: string; extractorName?: string }
  tags: Record<string, string>
  /** plugin rules that overran their time budget on this sample (not left stopped) */
  overran: string[]
  truncated: boolean
}

export function testSample(text: string, opts: { disabledRules?: readonly string[] } = {}): TestSampleResult {
  const truncated = text.length > TEST_SAMPLE_MAX_CHARS
  const sample = truncated ? text.slice(0, TEST_SAMPLE_MAX_CHARS) : text
  const detector = new LootDetector()
  detector.configure({ disabledRules: opts.disabledRules ?? [] })
  const { result: matches, overran } = withoutLeavingRulesStopped(() => detector.findMatches(sample))
  // Same composition the live path uses: values loot found are masked even
  // when entropy alone would not have caught them.
  const base = getRules()
  const rules = { ...base, denylist: [...base.denylist, ...new Set(matches.map((m) => m.value))] }
  const spans = redact(sample, rules).redacted
  return {
    masked: maskText(sample, spans),
    maskedSpans: spans.length,
    loot: matches.map((m) => ({
      type: m.type, confidence: m.confidence, reported: detector.isReported(m),
      ...(m.pluginId ? { pluginId: m.pluginId, patternName: m.patternName } : {})
    })),
    target: extractTargetWithProvenance(sample),
    tags: tagCommand(sample),
    overran,
    truncated
  }
}

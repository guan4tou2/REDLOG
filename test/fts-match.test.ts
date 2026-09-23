import { describe, it, expect } from 'vitest'
import { toFtsMatch } from '../src/core/query/fts-match'

// Event, HTTP body and recording search read text through this one function.
describe('toFtsMatch', () => {
  it('quotes each term, so punctuation matches as typed', () => {
    expect(toFtsMatch('nmap -sV 10.0.0.5')).toBe('"nmap" "-sV" "10.0.0.5"*')
  })
  it('prefix-matches only the last term', () => {
    expect(toFtsMatch('admi')).toBe('"admi"*')
  })
  it('escapes a double quote inside a term', () => {
    expect(toFtsMatch('say"hi')).toBe('"say""hi"*')
  })
  it('reads blank input as no query', () => {
    expect(toFtsMatch('   ')).toBeNull()
  })
})

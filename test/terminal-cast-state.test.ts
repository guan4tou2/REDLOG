import { describe, it, expect, afterEach } from 'vitest'
import type { WriteStream } from 'fs'
import { castState } from '../src/main/terminal-manager'
import { eventBus } from '../src/core/event-bus'

describe('terminal pane recording state', () => {
  afterEach(() => eventBus.resume('ui'))

  // No frame is written while recording is paused, so a pane with an open cast
  // is not recording then. It is paused — not failed, which is what "no rec"
  // on a pane whose cast never opened means.
  it('reads a pane with an open cast as paused while recording is paused', () => {
    const pane = { castStream: {} as WriteStream, castTruncated: false }
    expect(castState(pane)).toEqual({ recording: true, castTruncated: false, paused: false })
    eventBus.pause('ui')
    expect(castState(pane)).toEqual({ recording: false, castTruncated: false, paused: true })
  })

  it('does not call a pane paused when its cast never opened', () => {
    eventBus.pause('ui')
    expect(castState({ castStream: null, castTruncated: false })).toEqual({ recording: false, castTruncated: false, paused: false })
  })
})

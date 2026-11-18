import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { generateOperatorKeyPair } from '../src/core/signing'
import { clearIcacls, failNextIcacls, icaclsTargets, installIcaclsRecorder } from './helpers/icacls'

// restrictToOwner is an icacls child process with a 5 s timeout, and every new
// operator went through it for the keys directory. The directory only needs
// restricting once for as long as it is the same directory (#669). A directory
// that was removed and made again is a new one with the default ACL, so the
// memo is keyed on the directory's identity, not on its path alone. Counted on
// test/setup.ts's record of icacls calls, through the real fs-acl memo.

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const realUser = process.env.USERNAME

let root: string
let keys: string
let prevKeysDir: string | undefined

const keysDirCalls = (): number => icaclsTargets().filter((target) => target === keys).length
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  installIcaclsRecorder()
  clearIcacls()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  process.env.USERNAME = 'tester'
  prevKeysDir = process.env.REDLOG_KEYS_DIR
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-acl-memo-'))
  keys = path.join(root, 'keys')
  process.env.REDLOG_KEYS_DIR = keys
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  if (realUser === undefined) delete process.env.USERNAME
  else process.env.USERNAME = realUser
  if (prevKeysDir === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = prevKeysDir
  fs.rmSync(root, { recursive: true, force: true })
})

describe('keys directory ACL on win32', () => {
  it('is restricted once for many operators in the same directory', () => {
    generateOperatorKeyPair('op-a')
    generateOperatorKeyPair('op-b')
    generateOperatorKeyPair('op-c')

    expect(keysDirCalls()).toBe(1)
    // Each private key file is still restricted on its own.
    expect(icaclsTargets().filter((target) => target.endsWith('.key'))).toHaveLength(3)
  })

  it('is restricted again when the directory was removed and made again', async () => {
    generateOperatorKeyPair('op-a')
    expect(keysDirCalls()).toBe(1)

    fs.rmSync(keys, { recursive: true, force: true })
    await sleep(25) // coarse timestamps on some filesystems
    generateOperatorKeyPair('op-b')

    expect(keysDirCalls()).toBe(2)
    generateOperatorKeyPair('op-c')
    expect(keysDirCalls()).toBe(2)
  })

  it('is retried after a failed restriction', () => {
    failNextIcacls()
    generateOperatorKeyPair('op-a')
    generateOperatorKeyPair('op-b')

    expect(keysDirCalls()).toBe(2)
  })

  it('is restricted separately for a different directory', () => {
    generateOperatorKeyPair('op-a')
    const other = path.join(root, 'other-keys')
    process.env.REDLOG_KEYS_DIR = other
    generateOperatorKeyPair('op-a')

    expect(icaclsTargets().filter((target) => target === other)).toHaveLength(1)
    expect(keysDirCalls()).toBe(1)
  })
})

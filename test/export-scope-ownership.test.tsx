// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { getViewExport, useContributeExport } from '../src/renderer/src/lib/exportScope'

function Reader({name}:{name:string}): null {
  useContributeExport({label:name,request:{format:'json',subset:{kind:'all'}}})
  return null
}
afterEach(cleanup)
it('unmounting an older reader does not clear the active reader export selection',()=>{
  const older=render(<Reader name="older" />)
  const active=render(<Reader name="active" />)
  expect(getViewExport()?.label).toBe('active')
  older.unmount()
  expect(getViewExport()?.label).toBe('active')
  active.unmount()
  expect(getViewExport()).toBeNull()
})

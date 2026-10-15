import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { probeManagedProxy } from '../src/main/services/managed-http-proxy'

describe('owned proxy readiness', () => {
  for (const [body, expected] of [['owned-token', true], ['foreign-token', false], ['owned-token-extra', false]] as const) {
    it(`accepts only the owned response: ${body}`, async () => {
      const server = http.createServer((req, res) => {
        expect(req.url).toBe('http://redlog.verify.invalid/__redlog_ready')
        expect(JSON.stringify(req.headers)).not.toContain('owned-token')
        res.end(body)
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const port = (server.address() as { port: number }).port
        expect(await probeManagedProxy(`http://127.0.0.1:${port}`, 'owned-token')).toBe(expected)
      } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  }

  const python = ['python3', 'python'].find(exe => spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0)
  it.skipIf(!python)('the actual addon keeps readiness out of capture and user verification', () => {
    const script = `
import ast,sys,types
tree=ast.parse(open(sys.argv[1],encoding='utf8').read())
addon=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='RedLogAddon')
addon.body=[n for n in addon.body if isinstance(n,ast.FunctionDef) and n.name in ('_answer_verification','request','response','error')]
calls=[]
def response(status,body,headers): return types.SimpleNamespace(status_code=status,content=body,headers=headers)
http=types.SimpleNamespace(HTTPFlow=object,Response=types.SimpleNamespace(make=response))
env={'VERIFY_HOST':'redlog.verify.invalid','http':http,'os':types.SimpleNamespace(environ={'REDLOG_PROXY_READY_TOKEN':'owned-token'}),'_report_verification':lambda *a:calls.append(a)}
exec(compile(ast.Module(body=[addon],type_ignores=[]),sys.argv[1],'exec'),env)
instance=env['RedLogAddon']()
flow=types.SimpleNamespace(request=types.SimpleNamespace(pretty_host='redlog.verify.invalid',path='/__redlog_ready'))
instance.request(flow)
assert flow.response.status_code==200 and flow.response.content==b'owned-token'
instance.response(flow)
instance.error(flow)
assert not calls
env['os'].environ.clear()
instance.request(flow)
assert flow.response.status_code==403 and not flow.response.content
assert not calls
`
    const result = spawnSync(python!, ['-c', script, path.resolve('hooks/mitmproxy-addon.py')], { encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
})

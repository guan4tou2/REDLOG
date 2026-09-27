import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('serializes TLS certificate IP/DNS SANs without dropping the complete HTTP response', () => {
  // Execute the production extractor with stdlib equivalents of cryptography
  // GeneralName.value. No mitmproxy dependency is needed for this unit test.
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import ast, json, ipaddress, sys
from types import SimpleNamespace as N
source = ast.parse(open(sys.argv[1]).read())
extractor = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == '_extract_tls_info')
module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), extractor], type_ignores=[])
ns = {}
exec(compile(ast.fix_missing_locations(module), sys.argv[1], 'exec'), ns)
leaf = N(subject='lab', issuer='lab', serial=1, altnames=[N(value=ipaddress.ip_address('127.0.0.1')), N(value=ipaddress.ip_address('::1')), N(value='lab.test')])
flow = N(server_conn=N(tls_version='TLSv1.3', alpn=b'http/1.1', cipher='TLS_AES_256_GCM_SHA384', certificate_list=[leaf]))
print(json.dumps({'subtype': 'http_response', 'status': 404, 'tls': ns['_extract_tls_info'](flow)}))
`, join(__dirname, '..', 'hooks', 'mitmproxy-addon.py')], { encoding: 'utf8' })
  expect(JSON.parse(output).tls.cert_san).toEqual(['127.0.0.1', '::1', 'lab.test'])
})

import ast, base64, time, types, pathlib, __future__
source=ast.parse(pathlib.Path('hooks/mitmproxy-addon.py').read_text(encoding='utf-8'))
method=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='RedLogAddon')
method.body=[n for n in method.body if isinstance(n,ast.FunctionDef) and n.name=='responseheaders']
rows=[]
ns=dict(base64=base64,time=time,VERIFY_HOST='verify.invalid',urlparse=__import__('urllib.parse',fromlist=['urlparse']).urlparse,_send_to_redlog=lambda p:rows.append(p) or True)
exec(compile(ast.Module(body=[method],type_ignores=[]),'<production-sse>','exec',flags=__future__.annotations.compiler_flag),ns)
flow=types.SimpleNamespace(id='flow-A',metadata={'redlog_identity':{'engagementId':'A'}},request=types.SimpleNamespace(pretty_host='sse.test',pretty_url='http://sse.test/events',method='GET'),response=types.SimpleNamespace(headers={'content-type':'text/event-stream'},stream=False))
addon = ns['RedLogAddon']()
addon._request_times = {}
addon.responseheaders(flow)
chunk=('data: 中文😀\r\n\r\n'*10000).encode()
assert flow.response.stream(chunk)==chunk
assert len(rows)>1 and all(r['_identity']['engagementId']=='A' for r in rows)
assert b''.join(base64.b64decode(r['data']['response_body']['data']) for r in rows)==chunk
assert all(r['data']['response_body']['size']<=65536 for r in rows)
assert not flow.metadata['redlog_stream']['ended'], 'persist before response ends'
assert [r['data']['seq'] for r in rows]==list(range(1,len(rows)+1))
flow.response.stream(b'')
assert flow.metadata['redlog_stream']['ended']
# Preserve another addon transform; never mutate forwarded bytes or headers.
old=lambda b:b
flow.response.stream=old
addon.responseheaders(flow)
assert flow.response.stream is old
print('SSE bounded live byte preservation passed')

ns['hashlib'] = __import__('hashlib')
helpers = [n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in ('_capture_body','_is_text_content')]
constants = [n for n in source.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='TEXT_CONTENT_TYPES' for t in n.targets)]
exec(compile(ast.Module(body=constants+helpers,type_ignores=[]),'<production-bodies>','exec',flags=__future__.annotations.compiler_flag),ns)
prefix = '中文'.encode()[:2]
body = ns['_capture_body']('中文'.encode(),'text/plain',2)
assert body['encoding']=='base64' and base64.b64decode(body['data'])==prefix
assert body['sha256']==ns['hashlib'].sha256(prefix).hexdigest() and body['truncated']

import tempfile,pathlib,subprocess,json
relay=str(pathlib.Path('hooks/redlog-relay.py').resolve())
with tempfile.TemporaryDirectory(prefix='redlog-linux-output-') as root:
 root=pathlib.Path(root);work=root/'input';work.mkdir();(work/'visible.txt').write_text('file');(work/'.hidden').write_text('hidden')
 for name,cmd in [('ls','ls'),('ls-al','ls -al'),('large',"python3 -c \"print('ABCDEFGHIJ'*200000,end='')\""),('stderr','printf error >&2; exit 7')]:
  baseline=subprocess.run(['bash','-c',cmd],cwd=work,capture_output=True)
  run=subprocess.run(['python3',relay,'run','--event-out',str(root/'event.json'),'--cwd',str(work),'--captured-by','redlog-run','--command-id',name,'--','bash','-c',cmd],cwd=work,capture_output=True)
  event=json.loads((root/'event.json').read_text())
  assert run.stdout==baseline.stdout,(name,'stdout')
  assert run.stderr==baseline.stderr,(name,'stderr')
  assert run.returncode==baseline.returncode==event['exit_code'],name
  assert event['stdout_bytes']==len(baseline.stdout) and event['stderr_bytes']==len(baseline.stderr),name
  print(json.dumps({'case':name,'stdout_bytes':len(run.stdout),'stderr_bytes':len(run.stderr),'exit':run.returncode,'completeness':event.get('completeness'),'disposition':event.get('output_disposition')}))

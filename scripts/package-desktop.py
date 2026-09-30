"""Build an honest portable bundle using an official, hash-verified Node runtime."""
import argparse, hashlib, io, json, os, pathlib, shutil, subprocess, tarfile, urllib.request, zipfile
p=argparse.ArgumentParser();p.add_argument('--platform',choices=['win','darwin','linux'],required=True);p.add_argument('--arch',choices=['x64','arm64'],required=True);p.add_argument('--node-version',default='24.21.0');args=p.parse_args()
root=pathlib.Path(__file__).resolve().parent.parent;version=json.loads((root/'package.json').read_text())['version']
name=f'infinite-go-{version}-{args.platform}-{args.arch}-portable';stage=root/'.build'/name;stage.mkdir(parents=True,exist_ok=True);(stage/'runtime').mkdir(exist_ok=True);(stage/'app').mkdir(exist_ok=True)
ext='zip' if args.platform=='win' else 'tar.gz';prefix=f'node-v{args.node_version}-{args.platform}-{args.arch}';archive=f'{prefix}.{ext}';base=f'https://nodejs.org/dist/v{args.node_version}/'
def download(url):
 with urllib.request.urlopen(url,timeout=120) as response:return response.read()
sums=download(base+'SHASUMS256.txt').decode();expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1]==archive);data=download(base+archive)
if hashlib.sha256(data).hexdigest()!=expected:raise RuntimeError('Official Node archive SHA256 mismatch')
binary='node.exe' if args.platform=='win' else 'bin/node'
if ext=='zip':
 with zipfile.ZipFile(io.BytesIO(data)) as z:node=z.read(prefix+'/'+binary);license=z.read(prefix+'/LICENSE')
else:
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:node=t.extractfile(prefix+'/'+binary).read();license=t.extractfile(prefix+'/LICENSE').read()
exe=stage/'runtime'/('node.exe' if args.platform=='win' else 'node');exe.write_bytes(node);exe.chmod(0o755);(stage/'runtime'/'NODE-LICENSE').write_bytes(license)
files=['index.html','style.css','app.js','engine.js','annotations.js','tree.js','ai.js','providers.js','nigiri.js','host-address.js','deployment.js','manifest.webmanifest','server.js','package.json','LICENSE','NOTICE','README.md','README.en.md','katago-bridge.js','katago-analysis.cfg']
for name_ in files:shutil.copy2(root/name_,stage/'app'/name_)
for directory in ['assets','docs','local-ai']:shutil.copytree(root/directory,stage/'app'/directory,dirs_exist_ok=True)
shutil.copy2(root/'packaging'/'launcher.mjs',stage/'launcher.mjs');shutil.copy2(root/'LICENSE',stage/'LICENSE');shutil.copy2(root/'NOTICE',stage/'NOTICE')
(stage/'RUNTIME.txt').write_text(f'Official Node.js {args.node_version}, {args.platform} {args.arch}\nDownload: {base+archive}\nSHA256: {expected}\nThird-party license: runtime/NODE-LICENSE\nProject source: https://github.com/vavilonska/infinite-go\n',encoding='utf-8')
(stage/'START-HERE.txt').write_text('Infinite Go portable / 免安装版\nWindows: double-click Start-Infinite-Go.cmd\nmacOS: open Start-Infinite-Go.command if your OS permits it\nLinux: run ./Start-Infinite-Go.sh\nNo separate Node install. Keep the terminal open while hosting.\nBrowser guests: open the displayed LAN/VPN address, or enter it on the public Pages entrance. No app is required.\nThis bundle is not a notarized/signed installer. Respect OS security warnings; do not disable protections.\nNo automatic firewall changes. Only use trusted LAN/VPN members.\nOptional local AI settings appear in the automatically opened owner browser. Windows/Linux x64 can download verified CPU KataGo+small model after consent; macOS uses manual provider setup. KataGo engine/model not bundled. See app/docs/RELEASES.md.\n',encoding='utf-8')
if args.platform=='win':(stage/'Start-Infinite-Go.cmd').write_text('@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "launcher.mjs"\r\npause\r\n')
else:
 launcher=stage/('Start-Infinite-Go.command' if args.platform=='darwin' else 'Start-Infinite-Go.sh');launcher.write_text('#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec ./runtime/node ./launcher.mjs\n');launcher.chmod(0o755)
# Smoke-test this exact bundled runtime and server on the native CI runner.
import socket,time
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
env={**os.environ,'HOST':'127.0.0.1','PORT':str(port),'IG_NO_BROWSER':'1'}
process=subprocess.Popen([str(exe),str(stage/'launcher.mjs')],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
try:
 for attempt in range(80):
  if process.poll() is not None:raise RuntimeError(process.stdout.read().decode())
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=1) as response:
    if json.load(response)['ok']:break
  except (OSError,ValueError):time.sleep(.25)
 else:raise RuntimeError('Bundled server health check timed out')
 for path in ['/','/engine.js','/assets/icon.png','/manifest.webmanifest']:
  with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=5) as response:assert response.status==200
finally:process.terminate();process.wait(timeout=10)
output=root/'releases';output.mkdir(exist_ok=True);target=output/name
if args.platform=='win':shutil.make_archive(str(target),'zip',stage.parent,stage.name)
else:
 with tarfile.open(str(target)+'.tar.gz','w:gz') as t:t.add(stage,arcname=stage.name)
print(f'Packaged and smoke-tested {name}')

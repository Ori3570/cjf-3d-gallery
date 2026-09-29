"""Publish a dedicated new Pages repo using an existing Git credential.

Secrets remain in memory; they are never printed, saved, or added to remote URLs.
"""
from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent

def git(*args, capture=True):
    result = subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=capture,
                            encoding='utf-8', errors='replace',
                            env={**os.environ, 'GCM_INTERACTIVE': 'never', 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode:
        raise RuntimeError('Git 操作失败：' + ' '.join(args[:2]))
    return result.stdout.strip() if capture else ''

def credential():
    result = subprocess.run(['git', 'credential', 'fill'], cwd=ROOT,
                            input='protocol=https\nhost=github.com\n\n', text=True,
                            capture_output=True, encoding='utf-8', errors='replace', timeout=30,
                            env={**os.environ, 'GCM_INTERACTIVE': 'never', 'GIT_TERMINAL_PROMPT': '0'})
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if result.returncode or not values.get('password'):
        raise RuntimeError('当前 Git 未登录 GitHub。请先在本机完成 GitHub 登录，再运行发布；不要发送密码或 Token。')
    return values['password']

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default='cjf-3d-gallery')
    parser.add_argument('--owner', help='Optional expected signed-in GitHub account')
    parser.add_argument('--check', action='store_true', help='Only check authentication, without publishing')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', args.repo):
        raise RuntimeError('仓库名格式无效')
    token = credential()
    def api(path, method='GET', payload=None, missing_ok=False):
        request = Request('https://api.github.com' + path,
                          data=json.dumps(payload).encode() if payload is not None else None,
                          method=method, headers={'Authorization': 'Bearer ' + token,
                          'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cjf-3d-gallery-publisher'})
        try:
            with urlopen(request, timeout=45) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except HTTPError as error:
            if missing_ok and error.code == 404: return None
            raise RuntimeError(f'GitHub API 请求失败（HTTP {error.code}）：{method} {path}') from None
    user = api('/user')['login']
    if args.owner and user.lower() != args.owner.lower():
        raise RuntimeError(f'当前账号为 {user}，与指定账号不一致；未发布')
    if args.check:
        print(json.dumps({'authenticated': True, 'account': user}, ensure_ascii=False)); return
    endpoint = f'/repos/{user}/{args.repo}'
    remote = f'https://github.com/{user}/{args.repo}.git'
    state_path = ROOT / 'deployment-state.json'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    existing = api(endpoint, missing_ok=True)
    if existing and state.get('repository') != user + '/' + args.repo:
        raise RuntimeError('该仓库已存在且不属于本次发布记录；未覆盖。请换一个新的仓库名。')
    if not (ROOT / '.git').exists(): git('init', '-b', 'main')
    # Explicit allowlist: no original PLY, logs, local paths, verification images or credentials.
    files = ['index.html', 'style.css', 'viewer.js', 'sort-worker.js', '.nojekyll', '.gitignore',
             'README.md', 'prepare_assets.py', 'publish_github.py', 'serve.py', 'assets', 'licenses']
    git('add', '--', *files)
    changes = git('diff', '--cached', '--name-only')
    if changes: git('commit', '-m', 'Add cjf spatial portrait gallery with free camera controls')
    if not existing:
        existing = api('/user/repos', 'POST', {'name': args.repo, 'description': 'cjf spatial portrait — interactive 3D Gaussian gallery',
                       'private': False, 'auto_init': False})
        state = {'repository': user + '/' + args.repo, 'repository_url': existing['html_url']}
        state_path.write_text(json.dumps(state, indent=2), encoding='utf-8')
    current_remote = git('remote')
    if 'origin' in current_remote.splitlines():
        if git('remote', 'get-url', 'origin') != remote: raise RuntimeError('已有 origin 指向另一仓库，未修改')
    else: git('remote', 'add', 'origin', remote)
    git('push', '-u', 'origin', 'main')
    pages = api(endpoint + '/pages', missing_ok=True)
    if pages is None:
        pages = api(endpoint + '/pages', 'POST', {'build_type': 'legacy', 'source': {'branch': 'main', 'path': '/'}})
    state.update(pages_url=pages.get('html_url'), git_commit=git('rev-parse', 'HEAD'),
                 pages_status=pages.get('status', 'pending'))
    state_path.write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(json.dumps(state, ensure_ascii=False, indent=2))
    print('已提交并请求部署；仍须等待 Pages 构建成功和公开网址访问验证。')

if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr); sys.exit(1)

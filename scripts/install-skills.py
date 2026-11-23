"""Install app-owned Skill data. Never executes imported Skill scripts."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'skills'
HELPER = Path.home() / '.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py'
UPSTREAM = [
    ('anthropics/skills', 'skills/webapp-testing', 'Apache-2.0', 'skills/webapp-testing/LICENSE.txt'),
    ('obra/superpowers', 'skills/test-driven-development', 'MIT', 'LICENSE'),
    ('trailofbits/skills', 'plugins/static-analysis/skills/semgrep', 'CC-BY-SA-4.0', 'LICENSE'),
]

def get(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Audit-Desk'})
    with urllib.request.urlopen(request, timeout=40) as response:
        content = response.read(16 * 1024 * 1024 + 1)
        if len(content) > 16 * 1024 * 1024:
            raise ValueError('Download exceeds 16 MB')
        return content

def main():
    DEST.mkdir(exist_ok=True)
    manifest_path = DEST / 'manifest.json'
    if manifest_path.exists():
        installed = json.loads(manifest_path.read_text(encoding='utf-8'))
        if len(installed) == 5 and all((DEST / item['id'] / 'SKILL.md').is_file() and all((DEST / item['id'] / name).is_file() and hashlib.sha256((DEST / item['id'] / name).read_bytes()).hexdigest() == digest for name, digest in item['files'].items()) for item in installed):
            print('All 5 installed Skill directories verified locally; no network required.')
            return
    manifest = []
    for repo, skill_path, license_name, license_path in UPSTREAM:
        info = json.loads(get(f'https://api.github.com/repos/{repo}'))
        commit = json.loads(get(f'https://api.github.com/repos/{repo}/commits/{info["default_branch"]}'))['sha']
        target = DEST / skill_path.rsplit('/', 1)[1]
        # Existing installs were made by the same helper; compare upstream contents before recording a pin.
        if target.exists():
            upstream_skill = get(f'https://raw.githubusercontent.com/{repo}/{commit}/{skill_path}/SKILL.md')
            if (target / 'SKILL.md').read_bytes().replace(b'\r\n', b'\n') != upstream_skill.replace(b'\r\n', b'\n'):
                raise ValueError(f'{target} differs from pinned source; refusing overwrite')
        else:
            subprocess.run([sys.executable, str(HELPER), '--repo', repo, '--path', skill_path, '--ref', commit, '--dest', str(DEST), '--method', 'download'], check=True)
        license_data = get(f'https://raw.githubusercontent.com/{repo}/{commit}/{license_path}')
        (target / 'UPSTREAM-LICENSE.txt').write_bytes(license_data)
        record = {'id': target.name, 'repo': repo, 'path': skill_path, 'sha': commit, 'source': f'https://github.com/{repo}/tree/{commit}/{skill_path}', 'license': license_name, 'repositoryStars': info['stargazers_count']}
        (target / 'SOURCE.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
        manifest.append(record)
    local = [
        ('security-audit', Path.home() / '.codex/skills/security-audit'),
        ('open-code-review', Path.home() / '.codex/plugins/cache/open-code-review/open-code-review-codex/1.0.0/skills/open-code-review'),
    ]
    for name, source in local:
        target = DEST / name
        if not target.exists():
            shutil.copytree(source, target, symlinks=False)
        record = {'id': name, 'source': str(source), 'license': 'Apache-2.0' if name == 'open-code-review' else 'Local user-provided copy; no redistribution license identified'}
        (target / 'SOURCE.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
        manifest.append(record)
    for record in manifest:
        target = DEST / record['id']
        record['files'] = {str(file.relative_to(target)).replace('\\', '/'): hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(target.rglob('*')) if file.is_file()}
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'Installed {len(manifest)} complete Skill directories in {DEST}')

if __name__ == '__main__':
    main()

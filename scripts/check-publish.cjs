// Inspect the Git index, so only bytes about to be committed are checked.
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
// Bundled OFL font, reviewed by exact content hash; other binaries need review.
const allowedBinary = new Map([['src/ui/vendor/JetBrainsMono-Regular.woff2', 'f1a7a03672cdd494ce0d5543fac6e4360fe22403c6de297fdc2e55a815f7baff']]);

const rules = [
  ['模型密钥', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub 凭据', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['云访问密钥', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['私钥', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
  ['URL 内嵌凭据', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
  ['写死的凭据', /["']?(?:api[_-]?key|access[_-]?token|password|encryptedKey)["']?\s*[:=]\s*["'][A-Za-z0-9_+/.=-]{20,}["']/gi],
];
function matches(text) {
  return rules.flatMap(([name, pattern]) => {
    pattern.lastIndex = 0;
    return [...text.matchAll(pattern)].map(match => ({ name, line: text.slice(0, match.index).split('\n').length }));
  });
}

if (process.argv.includes('--self-test')) {
  assert.equal(matches('apiKey: process.env.MODEL_API_KEY').length, 0);
  assert.equal(matches("apiKey: 'fixture-key'").length, 0);
  assert(matches('sk-' + 'a'.repeat(32)).length > 0);
  assert(matches('ghp_' + 'b'.repeat(36)).length > 0);
  assert(matches('-----BEGIN ' + 'PRIVATE KEY-----').length > 0);
  assert(matches('encryptedKey: "' + 'c'.repeat(40) + '"').length > 0);
  console.log('发布扫描自检通过。');
} else {
  const git = args => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const ignored = git(['ls-files', '--cached', '--ignored', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  const failures = ignored.map(file => `${file}: 已被忽略但仍在索引中`);
  const entries = git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean);
  if (!entries.length) failures.push('Git 索引为空，请先 git add .');
  let checked = 0;
  for (const entry of entries) {
    const split = entry.indexOf('\t'), file = entry.slice(split + 1), mode = entry.slice(0, 6);
    if (!['100644', '100755'].includes(mode)) { failures.push(`${file}: 不上传符号链接或子模块`); continue; }
    const data = git(['show', ':' + file]);
    if (data.length > 5 * 1024 * 1024) { failures.push(`${file}: 超过 5 MiB，须单独检查`); continue; }
    if (data.includes(0) && allowedBinary.get(file) !== createHash('sha256').update(data).digest('hex')) { failures.push(`${file}: 二进制文件，须单独检查`); continue; }
    checked++;
    for (const match of matches(data.toString('utf8'))) failures.push(`${file}:${match.line}: ${match.name}`);
  }
  if (failures.length) {
    console.error('阻止提交；仅显示位置，不显示匹配内容：\n' + failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`检查通过：${checked} 个索引文件，未匹配凭据规则；未发现已忽略文件或未经核对的二进制产物。`);
}

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('indexing excludes credentials, ignores and validates scopes', async () => {
  const { indexProject, selectFiles } = require('../dist/project');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-project-'));
  try {
    await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'a.ts'), "import { lib } from '../lib'; export const a = lib;");
    await fs.writeFile(path.join(root, 'lib.ts'), 'export const lib = 1;');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=private'); await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored');
    const result = await indexProject(root);
    assert.equal(result.files.find(f => f.path === '.env').status, 'skipped');
    assert.equal(result.files.find(f => f.path === 'ignored.txt').content, undefined);
    assert.equal(selectFiles(result, ['src']).length, 1);
    assert.throws(() => selectFiles(result, ['../escape'])); assert.throws(() => selectFiles(result, ['missing']));
    assert.equal(result.languages.TypeScript, 2);
    assert.ok(selectFiles(result, ['(root)']).every(file => !file.path.includes('/')));
    assert.ok(selectFiles(result, ['(root)']).some(file => file.path === 'lib.ts'));
    assert.match(result.diagram, /static import inference/); assert.match(result.diagram, /lib.ts/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('registry snapshots skill assets, disables selection, rejects invalid frontmatter', async () => {
  const { SkillRegistry } = require('../dist/skills');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-skills-'));
  try {
    const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'references'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: example\ndescription: A small check\n---\nRead the code.');
    await fs.writeFile(path.join(source, 'references', 'guide.md'), 'Guide');
    const registry = new SkillRegistry(path.join(root, 'store'), path.join(root, 'bundled')); await registry.init();
    const record = await registry.importLocal(source); assert.equal(record.id, 'example');
    assert.match((await registry.inspect('example')).content, /Read the code/);
    assert.match(await registry.instructions(['example']), /Read the code/);
    assert.equal((await registry.versions(['example']))[0].hash, record.hash);
    const edited = await registry.updateContent('example', '---\nname: example\ndescription: Updated check\n---\nRead carefully.');
    assert.notEqual(edited.hash, record.hash); assert.match(await registry.instructions(['example']), /Read carefully/);
    await assert.rejects(registry.updateContent('example', '---\nname: renamed\ndescription: X\n---\nX'));
    await assert.rejects(registry.inspect('con'));
    await registry.setEnabled('example', false); await assert.rejects(registry.instructions(['example']));
    await registry.setEnabled('example', true);
    await fs.writeFile(path.join(record.path, 'references', 'guide.md'), 'changed');
    await assert.rejects(registry.instructions(['example']), /changed/);
    await assert.rejects(registry.remove('../source'));
    await fs.writeFile(path.join(source, 'SKILL.md'), 'No frontmatter'); await assert.rejects(registry.importLocal(source));
    await registry.remove('example'); assert.equal((await registry.list()).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('registry imports all bundled skill assets and source provenance', async () => {
  const { SkillRegistry } = require('../dist/skills');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-bundles-'));
  try {
    const registry = new SkillRegistry(root, path.resolve(__dirname, '../skills')); await registry.init();
    const records = await registry.list(); assert.equal(records.length, 5);
    const semgrep = records.find(record => record.id === 'semgrep');
    assert.match(semgrep.sha, /^[a-f0-9]{40}$/); assert.equal(semgrep.license, 'CC-BY-SA-4.0');
    assert.match(await registry.instructions(records.map(record => record.id)), /Security Audit/);
    const actualGuidance = await registry.instructions(['security-audit']);
    for (const name of ['RECONNAISSANCE.md', 'HUNTING.md', 'VALIDATION-AND-REPORTING.md', 'ATTACK-CLASSES.md']) assert.ok(actualGuidance.includes(`--- security-audit/${name} ---`));
    assert.doesNotMatch(actualGuidance, /REQUIRED REFERENCE GAP/);
    assert.match(actualGuidance, /OPTIONAL REFERENCE OMISSIONS/);
    assert.ok(actualGuidance.length <= 256000);
    assert.ok(records.find(item => item.id === 'semgrep').warnings.some(warning => /Bash/.test(warning)));
    assert.ok(records.find(item => item.id === 'webapp-testing').warnings.some(warning => /Playwright/.test(warning)));
    await registry.remove('semgrep'); await registry.init(); assert.equal((await registry.list()).length, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

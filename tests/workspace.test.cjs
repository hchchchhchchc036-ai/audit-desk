const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WorkspaceStore } = require('../dist/workspace');

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'));
  try {
    const snapshot = async name => {
      const dir = path.join(root, name); await fs.mkdir(dir);
      const real = await fs.realpath(dir);
      return { id: createHash('sha256').update(real).digest('hex').slice(0, 16), root: real, name, indexedAt: new Date().toISOString(), files: [], modules: [], languages: {}, diagram: '', warnings: [] };
    };
    const a = await snapshot('alpha'), b = await snapshot('beta');
    const store = new WorkspaceStore(path.join(root, 'data')); await store.init();
    await run({ root, store, a, b });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('workspace persists selection, isolates projects, restores archived entries and preserves source', () => fixture(async ({ root, store, a, b }) => {
  const first = await store.register(a); await store.register(b);
  await store.select(a.id);
  await store.append(a.id, first.contextId, 'user', 'alpha target');
  assert.match(await store.memory(a.id), /alpha target/);
  assert.doesNotMatch(await store.memory(b.id), /alpha target/);
  await store.archive(a.id); assert.equal((await store.list()).length, 1);
  assert.ok((await fs.stat(a.root)).isDirectory());
  const restored = await store.register(a); assert.equal(restored.contextId, first.contextId);
  const reopened = new WorkspaceStore(path.join(root, 'data')); await reopened.init();
  await reopened.select(a.id); assert.equal(reopened.activeId(), a.id);
  assert.equal((await reopened.getContext(a.id)).messages[0].content, 'alpha target');
  assert.deepEqual(await fs.readdir(a.root), []);
}));

test('compact preserves identity, original archive and recent messages; reset imports handoff and rejects stale appends', () => fixture(async ({ store, a }) => {
  const entry = await store.register(a);
  for (let i = 0; i < 4; i++) await store.append(a.id, entry.contextId, i % 2 ? 'assistant' : 'user', `original-${i}`);
  const compacted = await store.compact(a.id, async prompt => {
    assert.match(prompt, /original-0/); assert.match(prompt, /decisions/i); return 'Target alpha. Verified current status; next: test.';
  });
  assert.equal(compacted.id, entry.contextId); assert.equal(compacted.generation, 1);
  assert.equal(compacted.messages.filter(m => m.role !== 'system').length, 2);
  const reset = await store.reset(a.id, async prompt => { assert.match(prompt, /original-3/); return '# Alpha handoff\nGoal and next step'; });
  assert.notEqual(reset.id, entry.contextId); assert.equal(reset.generation, 2);
  assert.match(reset.messages[0].content, /Alpha handoff/);
  assert.match(await fs.readFile(reset.handoffPath, 'utf8'), /Alpha handoff/);
  await assert.rejects(store.append(a.id, entry.contextId, 'user', 'stale'), /stale/i);
  assert.match(await store.memory(a.id), /Alpha handoff/);
}));

test('compression failures preserve state and mutations serialize across model waits', () => fixture(async ({ store, a, b }) => {
  const entry = await store.register(a); const other = await store.register(b);
  await store.append(a.id, entry.contextId, 'user', 'keep me');
  const before = await store.getContext(a.id);
  for (const summarize of [async () => { throw Error('offline'); }, async () => '', async () => 'x'.repeat(200001)]) {
    await assert.rejects(store.reset(a.id, summarize)); assert.deepEqual(await store.getContext(a.id), before);
  }
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  const pending = store.compact(a.id, async () => { entered(); return new Promise(resolve => { release = resolve; }); });
  await started;
  let appended = false;
  const queued = store.append(a.id, entry.contextId, 'user', 'after compact').then(() => { appended = true; });
  await store.append(b.id, other.contextId, 'user', 'independent'); assert.equal(appended, false);
  release('Valid summary'); await pending; await queued;
  assert.equal((await store.getContext(a.id)).messages.at(-1).content, 'after compact');
}));

test('memory bounds, token counters and malformed requests are checked', () => fixture(async ({ store, a }) => {
  const entry = await store.register(a);
  await store.append(a.id, entry.contextId, 'user', 'a'.repeat(1000));
  const memory = await store.memory(a.id, 100); assert.ok(memory.length <= 100); assert.match(memory, /truncat/i);
  await store.recordUsage(a.id, entry.contextId, { inputTokens: 10, outputTokens: 3, totalTokens: 13, estimated: false });
  const usage = (await store.getContext(a.id)).usage;
  assert.equal(usage.totalTokens, 13); assert.equal(usage.calls, 1); assert.equal(usage.lastInputTokens, 10);
  await assert.rejects(store.recordUsage(a.id, entry.contextId, { inputTokens: -1, outputTokens: 0 }));
  await assert.rejects(store.getContext('../escape'));
  await assert.rejects(store.register({ ...a, id: 'a'.repeat(16), root: a.root }));
  await assert.rejects(store.append(a.id, entry.contextId, 'tool', 'bad role'));
}));

test('a failed final commit leaves the old context intact and archived originals remain readable', () => fixture(async ({ root, store, a }) => {
  const entry = await store.register(a); await store.select(a.id);
  await store.append(a.id, entry.contextId, 'user', 'original evidence');
  const before = await store.getContext(a.id);
  const current = path.join(root, 'data', 'projects', a.id, 'current.json');
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === current) throw Error('simulated disk commit failure'); return rename(from, to); };
  try { await assert.rejects(store.reset(a.id, async () => 'New handoff'), /disk commit/); }
  finally { fs.rename = rename; }
  assert.deepEqual(await store.getContext(a.id), before);
  assert.equal(store.activeId(), a.id);
  const archive = path.join(root, 'data', 'projects', a.id, 'archive');
  const versions = await fs.readdir(archive); assert.equal(versions.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(archive, versions[0], 'context.json'), 'utf8'));
  assert.deepEqual(saved.context, before);
  await store.append(a.id, entry.contextId, 'user', 'still usable');
}));

test('malformed saved state and linked store paths are rejected', () => fixture(async ({ root, store, a }) => {
  await store.register(a);
  const current = path.join(root, 'data', 'projects', a.id, 'current.json');
  const raw = await fs.readFile(current, 'utf8');
  const state = JSON.parse(raw); state.context.projectId = 'f'.repeat(16);
  await fs.writeFile(current, JSON.stringify(state));
  await assert.rejects(store.getContext(a.id), /context/i);
  const reopened = new WorkspaceStore(path.join(root, 'data'));
  await assert.rejects(reopened.init(), /context/i);
  await fs.writeFile(current, raw);
  const alias = path.join(root, 'linked-data');
  await fs.symlink(path.join(root, 'data'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new WorkspaceStore(alias).init(), /links/i);
}));

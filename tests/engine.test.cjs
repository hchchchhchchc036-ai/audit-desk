const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskEngine, testEvidence,normalizeRunnerOutput } = require('../dist/engine');
const { writeReport } = require('../dist/reports');

const project = { id: 'project', name: 'Fixture', root: '/fixture', indexedAt: new Date().toISOString(), files: [
  { path: 'a/test.js', content: 'eval(userInput)', size: 15, status: 'read' },
  { path: 'ab/other.js', content: 'unrelated()', size: 11, status: 'read' },
  { path: '.env', size: 10, status: 'skipped', reason: 'secret' }
], modules: ['a', 'ab'], languages: {}, diagram: 'flowchart LR\n a --> b', warnings: [] };
async function setup(modelCall) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-engine-'));
  const opts = { dataDir, settings: () => ({ protocol: 'openai', baseUrl: '', model: 'test', apiKey: 'private-api-key', timeoutSeconds: 30, maxInputChars: 20000, maxOutputTokens: 1000, concurrency: 1, tokenBudget: 200000, containerImage: 'local:test', testExecution: 'docker' }), modelCall, skillInstructions: async () => 'test skill', skillVersions: async () => [{ id: 'test', hash: 'locked' }], ocr: async () => ({ code: 0, stdout: '{}', stderr: '' }), emit: () => {} };
  const engine = new TaskEngine(opts); await engine.init();
  return { engine, opts, cleanup: () => fs.rm(dataDir, { recursive: true, force: true }) };
}
async function done(engine, id) {
  for (let i = 0; i < 200; i++) { const t = engine.get(id); if (t.finishedAt) { await new Promise(r => setTimeout(r, 40)); return engine.get(id); } await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Task did not finish');
}
test('default local mode discovers existing tests and generates fenced JSON tests without Docker', async () => {
  const ctx = await setup(async () => {
    ctx.engine.recordUsage({ inputTokens: 50, outputTokens: 20, estimated: false });
    return '```json\n' + JSON.stringify({plan:'node assertion',command:['node','--test','generated-tests/check.test.cjs'],files:[{path:'generated-tests/check.test.cjs',content:"require('node:test')('real assertion',()=>require('node:assert/strict').equal(2+2,4));"}]}) + '\n```';
  });
  const settings = ctx.opts.settings(); ctx.opts.settings = () => ({...settings,testExecution:undefined});
  ctx.engine.process = async () => { throw new Error('Docker must never be invoked'); };
  const localProject = {...project,files:[{path:'tests/example.test.cjs',status:'read',size:100,content:"require('node:test')('existing test',()=>require('node:assert/strict').equal(1,1));"}]};
  try {
    let t = await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:false},localProject).id);
    assert.equal(t.status,'passed',t.summary);assert.equal(t.metrics.executionMode,'local');assert.equal(t.metrics.usage,undefined);
    assert.ok(t.metrics.flowEvents.some(e=>e.tool==='local-process'&&e.status==='completed'));
    t = await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:true},localProject).id);
    assert.equal(t.status,'passed',t.summary);assert.equal(t.metrics.usage.totalTokens,70);assert.equal(t.metrics.passed,1);
    assert.match(await fs.readFile(path.join(t.reportDir,'runner-output.log'),'utf8'),/pass 1/);
  } finally { await ctx.cleanup(); }
});

test('model timeout stops the audit after one request instead of repeating all phases', async () => {
  let requests=0;
  const ctx=await setup(async()=>{requests++;throw Object.assign(new Error('模型请求超过 120 秒，已停止'),{code:'MODEL_TIMEOUT'});});
  try{
    const t=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['a'],skillIds:[]},project).id);
    assert.equal(requests,1);assert.equal(t.status,'partial');assert.match(t.summary,/120/);
    assert.equal(t.metrics.jobs.length,1);assert.equal(t.metrics.jobs[0].status,'failed');
  }finally{await ctx.cleanup();}
});

test('finding keeps root cause and only retains dependency references with matching source evidence',async()=>{
  const ctx=await setup(async()=> '{}');
  try{
    const f=ctx.engine.finding({path:'a/test.js',line:1,title:'输入校验缺失',detail:'外部输入进入解释器',evidence:'eval(userInput)',dependencies:[{name:'解释器',kind:'module',file:'a/test.js',line:1,evidence:'eval(userInput)',relationship:'该调用将输入交给解释器',version:'invented-version'},{name:'虚构库',kind:'package',file:'missing.json',line:1,evidence:'nonexistent'}]},project.files,'security-audit');
    assert.equal(f.dependencies.length,1);assert.equal(f.dependencies[0].version,undefined);assert.equal(f.rootCause,'外部输入进入解释器');
    f.detail='尚待进一步验证';assert.equal(f.rootCause,'外部输入进入解释器');
    const cases=ctx.engine.testCases("not ok 1 - 拒绝越权输入\n  location: 'tests/auth.test.js:12:3'\n  expected: 403\n  actual: 200");
    assert.equal(cases[0].status,'failed');assert.equal(cases[0].expected,'403');assert.equal(cases[0].actual,'200');assert.match(cases[0].cause,/实际结果与预期不一致/);assert.match(cases[0].location,/tests\/auth.test.js:12:3/);
  }finally{await ctx.cleanup();}
});

test('runner success needs real nonempty evidence', () => {
  assert.deepEqual(testEvidence(''), { passed: 0, failed: 0 });
  assert.equal(testEvidence('0 passed in 0.01s').passed, 0);
  assert.equal(testEvidence('# pass 3\n# fail 1').failed, 1);
  assert.deepEqual(testEvidence('ℹ pass 2\nℹ fail 0'), {passed:2,failed:0});
  assert.equal(testEvidence('2 passed, 1 failed in 2s').passed, 2);
  const summary=JSON.stringify({auditDeskResults:true,passed:2,failed:0});
  assert.equal(testEvidence(summary+'\n# fail 1\n'+summary).failed,1,'later failures cannot be hidden by an earlier JSON summary');
  assert.equal(testEvidence('# fail 3\n'+summary).failed,3);
});

test('TAP-prefixed metrics and split artifact records preserve real measurements and payload bytes',async()=>{
  const metrics={p95Ms:3,requests:40};assert.equal(testEvidence('# '+JSON.stringify({auditDeskResults:true,passed:1,failed:0,metrics})).metrics.p95Ms,3);
  const ctx=await setup(async()=> '{}');
  try{const content='实际浏览器日志\n'.repeat(100),record=JSON.stringify({auditDeskArtifact:true,name:'browser.log',mime:'text/plain',base64:Buffer.from(content).toString('base64')});const output=record.match(/.{1,100}/g).map(line=>'# '+line).join('\n')+'\nnot ok 1 - 后续失败\n# fail 1';const normalized=normalizeRunnerOutput(output);assert.ok(normalized.includes(record));assert.equal(testEvidence(normalized).failed,1);const task={reportDir:ctx.opts.dataDir};const artifacts=await ctx.engine.streamArtifacts(task,output);assert.equal(artifacts.length,1);assert.equal(await fs.readFile(path.join(ctx.opts.dataDir,'artifacts/browser.log'),'utf8'),content);}finally{await ctx.cleanup();}
});

test('generated directory commands run explicit files with unchanged large assets and ESM browser imports',async()=>{
  const {indexProject}=require('../dist/project');let calls=0;
  const ctx=await setup(async()=>{calls++;return JSON.stringify({plan:'验证资源快照和 ESM 运行器',command:['node','--test','generated-tests'],files:[{path:'generated-tests/asset.test.mjs',content:"import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {chromium} from 'playwright';test('真实大图片和浏览器客户端可读取',()=>{assert.equal(fs.statSync('images/photo.png').size,3145728);assert.equal(typeof chromium.launch,'function');});"}]});});
  const configured=ctx.opts.settings();ctx.opts.settings=()=>({...configured,testExecution:'local'});
  try{const site=path.join(ctx.opts.dataDir,'site');await fs.mkdir(path.join(site,'images'),{recursive:true});await fs.writeFile(path.join(site,'images/photo.png'),Buffer.alloc(3*1024*1024));await fs.writeFile(path.join(site,'index.html'),'<img src="images/photo.png">');const snapshot=await indexProject(site);assert.ok(snapshot.files.find(f=>f.path==='images/photo.png').hash);let task=await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:true},snapshot).id);assert.equal(task.status,'passed',task.summary);assert.ok(task.metrics.command.includes('generated-tests/asset.test.mjs'));await fs.writeFile(path.join(site,'images/photo.png'),Buffer.alloc(3*1024*1024,1));task=await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:true},snapshot).id);assert.equal(task.status,'partial');assert.match(task.summary,/资源内容已变化/);assert.equal(calls,1);}finally{await ctx.cleanup();}
});

test('test-harness repair needs source evidence and retains the original failure',async()=>{
  let calls=0,verified=true;const source='exports.add = (a,b) => a+b;';
  const ctx=await setup(async()=>{calls++;return JSON.stringify({plan:'依据加法实现修正错误测试预期',command:['node','--test','generated-tests/add.test.cjs'],files:[{path:'generated-tests/add.test.cjs',content:`require('node:test')('相加结果',()=>require('node:assert/strict').equal(require('../src/add.js').add(1,1),${calls===1?3:2}));`}],...(calls>1&&verified?{repairs:[{reason:'源码计算 1+1=2，原测试错误地期待 3；保持相同输入与断言覆盖',evidence:[{file:'src/add.js',line:1,excerpt:source}]}]}:{})});});
  const configured=ctx.opts.settings();ctx.opts.settings=()=>({...configured,testExecution:'local'});const snapshot={...project,files:[{path:'src/add.js',status:'read',size:source.length,content:source}]};
  try{let task=await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:true},snapshot).id);assert.equal(task.status,'passed',task.summary);assert.equal(task.metrics.testAttempts.length,2);assert.equal(task.metrics.testAttempts[0].status,'failed');assert.equal(task.metrics.testAttempts[1].status,'passed');assert.match(await fs.readFile(path.join(task.reportDir,'attempts/1/runner-output.log'),'utf8'),/not ok/);assert.equal(await fs.readFile(path.join(task.reportDir,'source/src/add.js'),'utf8'),source);assert.match(await fs.readFile(path.join(task.reportDir,'report.md'),'utf8'),/首次失败/);calls=0;verified=false;task=await done(ctx.engine,ctx.engine.start({kind:'test',testType:'unit',scopes:['.'],skillIds:[],generate:true},snapshot).id);assert.equal(task.status,'failed');assert.match(task.summary,/缺少可核对/);assert.equal(task.metrics.testAttempts.length,1);}finally{await ctx.cleanup();}
});
test('scope boundaries, fresh verification, ledger and report escaping', async () => {
  const prompts = [];
  const ctx = await setup(async (system, prompt) => { prompts.push(prompt);
    if (system.includes('reconnaissance')) return '{"summary":"a/test.js:1 source boundary","units":[],"gaps":[]}';
    if (system.includes('critic') || system.includes('criticize')) return '{"clean":true,"gaps":[],"reassignPaths":[]}';
    if (system.includes('cross-module')) return '{"findings":[]}';
    if (system.includes('verify') || system.includes('verifier')) return '{"status":"needs_validation","detail":"Source evidence is present; runtime result blocked","blockers":["No isolated reproduction"],"validation_plan":{"local":"Use offline dummy input fixture"}}';
    return JSON.stringify({ findings: [{ path: 'a/test.js', line: 1, title: '<script>alert(1)</script>', detail: 'private-api-key', evidence: 'eval(userInput)' }, { path: '../escape', line: 1, title: 'bad', detail: 'bad' }] }); });
  try {
    const t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', engine: 'security-audit', scopes: ['a'], skillIds: ['test'] }, project).id);
    assert.equal(t.status, 'partial'); assert.equal(t.coverage.total, 1); assert.equal(t.coverage.reviewed, 1); assert.equal(t.findings.length, 1); assert.equal(t.findings[0].status, 'needs_validation'); assert.ok(prompts.length >= 10); assert.ok(prompts.every(p => !p.includes('unrelated()')));
    assert.equal(t.metrics.localSchemaValid, true); assert.equal(t.metrics.coverageValid, true);
    assert.equal(t.metrics.companionSchemaValidated, true, JSON.stringify(t.metrics.validationErrors));
    const records = JSON.parse(await fs.readFile(path.join(t.reportDir, 'findings.json'), 'utf8')); assert.ok(Array.isArray(records)); assert.equal(records[0].verdict, 'needs_validation'); assert.ok(records[0].trace.length); assert.ok(!('severity' in records[0]));
    const html = await fs.readFile(path.join(t.reportDir, 'report.html'), 'utf8'); assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('private-api-key'));
    const report = JSON.parse(await fs.readFile(path.join(t.reportDir, 'report.json'), 'utf8')); assert.ok(report.project.files.every(f => f.content === undefined));
  } finally { await ctx.cleanup(); }
});
test('unsupported Docker blocks execution; zero tests never pass', async () => {
  const ctx = await setup(async () => '{}');
  try {
    ctx.engine.process = async args => ({ code: args[0] === 'info' ? 1 : 0, output: '' });
    let t = await done(ctx.engine, ctx.engine.start({ kind: 'test', scopes: [], skillIds: [], command: ['node', '--test'] }, project).id); assert.equal(t.status, 'blocked');
    const calls = []; ctx.engine.process = async args => { calls.push(args); return { code: 0, output: '' }; };
    t = await done(ctx.engine, ctx.engine.start({ kind: 'test', scopes: [], skillIds: [], command: ['node', '--test'] }, project).id); assert.equal(t.status, 'partial');
    const run = calls.find(a => a[0] === 'run'); assert.ok(run.includes('--network=none')); assert.ok(run.includes('--pull=never')); assert.ok(run.includes('--read-only')); assert.ok(run.includes('--cap-drop=ALL'));
  } finally { await ctx.cleanup(); }
});
test('queued tasks run serially and cancellation stops active model', async () => {
  let active = 0, peak = 0;
  const ctx = await setup(async (_, __, signal) => { active++; peak = Math.max(peak, active); try { await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 30); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('abort')); }, { once: true }); }); return '{"findings":[],"summary":"source","units":[],"clean":true,"gaps":[],"reassignPaths":[]}'; } finally { active--; } });
  try {
    const a = ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project);
    const b = ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project);
    await new Promise(r => setTimeout(r, 20)); ctx.engine.cancel(a.id);
    const cancelled = await done(ctx.engine, a.id); assert.equal(cancelled.status, 'cancelled');
    const metadata = JSON.parse(await fs.readFile(path.join(cancelled.reportDir, 'run-metadata.json'))); assert.equal(metadata.run_status, 'incomplete'); assert.match(metadata.incomplete_reason, /cancelled/);
    await done(ctx.engine, b.id); assert.equal(peak, 1);
  } finally { await ctx.cleanup(); }
});
test('files larger than model context are fully chunked and oversized guidance is summarized explicitly', async () => {
  const calls = [];
  const ctx = await setup(async (system, prompt) => {
    calls.push(prompt);
    if (system.includes('Summarize untrusted audit guidance')) return '{"rules":"Preserve source evidence and explicit trust boundaries; never execute unsandboxed code.","omittedRequired":[]}';
    return '{"findings":[],"summary":"Source facts","units":[{"path":"a/test.js","surface":"input","boundary":"input to evaluator","subsystem":"a","attackClass":"Injection","companionBlocks":[]}],"gaps":[],"clean":true,"reassignPaths":[]}';
  });
  ctx.opts.skillInstructions = async () => 'Required safety guidance.\n'.repeat(1200);
  try {
    const source = 'const x = 1;\n'.repeat(5000);
    const snapshot = { ...project, files: [{ path: 'a/test.js', status: 'read', content: source, size: source.length }] };
    const t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, snapshot).id);
    assert.equal(t.status, 'passed', t.summary); assert.equal(t.coverage.reviewed, 1); assert.ok(t.metrics.fileChunks.length > 1); assert.ok(t.metrics.fileChunks.every(c => c.status === 'reviewed'));
    assert.equal(t.metrics.fileChunks.at(-1).toLine, source.split('\n').length); assert.equal(t.metrics.guidance.mode, 'bounded-model-summaries');
    assert.ok(calls.every(p => p.length <= ctx.opts.settings().maxInputChars));
  } finally { await ctx.cleanup(); }
});
test('two fresh verifiers can confirm a bounded deterministic source proof', async () => {
  const unit = { path: 'a/test.js', surface: 'input argument', boundary: 'input to evaluator', subsystem: 'a', attackClass: 'Injection', companionBlocks: [] };
  const candidate = { path: 'a/test.js', line: 2, title: 'Input reaches evaluator', detail: 'Evaluator accepts user-controlled expression', evidence: 'return eval(userInput);', boundary: { principal: 'argument caller', input: 'expression', control: 'data-only input', crossing: 'data to code', resource: 'process authority', result: 'expression evaluated as code' }, trace: [{ kind: 'entrypoint', file: 'a/test.js', line: 1, scope: 'handle', description: 'Accept argument', excerpt: 'function handle(userInput) {' }, { kind: 'sink', file: 'a/test.js', line: 2, scope: 'handle', description: 'Evaluate as code', excerpt: 'return eval(userInput);' }] };
  const proof = { deterministic: true, principal: 'argument caller', input: '1+2', control: 'data-only argument', crossing: 'data becomes evaluated code', resource: 'process evaluator', result: 'input expression reaches the evaluator without a data-only check', checks: [{ file: 'a/test.js', line: 2, excerpt: 'return eval(userInput);' }] };
  const ctx = await setup(async (system) => {
    ctx.engine.recordUsage({inputTokens:100,outputTokens:100,estimated:false});
    if (system.includes('final record verifier')) return JSON.stringify({ status: 'confirmed', severity: 'high', detail: 'Source-only deterministic boundary result', blockers: [], sourceProof: proof });
    if (system.includes('Independently verify')) return '{"status":"confirmed","detail":"Source trace is deterministic"}';
    if (system.includes('reconnaissance')) return JSON.stringify({ summary: 'Source', units: [unit], gaps: [] });
    if (system.includes('critic')) return '{"clean":true,"gaps":[],"reassignPaths":[]}';
    if (system.includes('cross-module')) return '{"findings":[]}';
    return JSON.stringify({ findings: Array.from({length:6},(_,index)=>({...candidate,title:candidate.title+' '+index})), units: [unit] });
  });
  const configured=ctx.opts.settings();ctx.opts.settings=()=>({...configured,maxOutputTokens:32000});
  try {
    const snapshot = { ...project, files: [{ path: 'a/test.js', status: 'read', content: 'function handle(userInput) {\n return eval(userInput);\n}', size: 55 }] };
    const t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, snapshot).id);
    assert.equal(t.status, 'failed', t.summary); assert.equal(t.findings[0].status, 'confirmed'); assert.equal(t.metrics.companionSchemaValidated, true, JSON.stringify(t.metrics.validationErrors));
    assert.equal(t.findings.filter(f=>f.status==='confirmed').length,6,'all verifications use actual token reconciliation');
    assert.equal(t.metrics.remainingTokenEstimate,configured.tokenBudget-t.metrics.usage.totalTokens);
    const records = JSON.parse(await fs.readFile(path.join(t.reportDir, 'findings.json'))); assert.equal(records[0].verdict, 'confirmed'); assert.match(records[0].execution.observed_result, /Statically/); assert.equal(records[0].severity.overall_severity, 'high');
  } finally { await ctx.cleanup(); }
});
test('real bundled security-audit guidance completes through the actual loader without optional-reference false gaps', async () => {
  const { SkillRegistry } = require('../dist/skills');
  const ctx = await setup(async (system) => {
    if (system.includes('Summarize untrusted audit guidance')||system.includes('Consolidate these required audit rules')) return '{"rules":"Follow six phases, plan actual boundary/class units, validate source evidence independently, honor sandbox boundaries, and run canonical validators. Optional unassigned companions are not required.","omittedRequired":[]}';
    return '{"findings":[],"summary":"Source facts","units":[{"path":"a/test.js","surface":"input","boundary":"input to evaluator","subsystem":"a","attackClass":"Injection","companionBlocks":[]}],"gaps":[],"clean":true,"reassignPaths":[]}';
  });
  try {
    const registry = new SkillRegistry(path.join(ctx.opts.dataDir, 'skills'), path.resolve(__dirname, '../skills')); await registry.init();
    const instructions = await registry.instructions(['security-audit']); assert.ok(instructions.includes('RECONNAISSANCE.md')); assert.ok(!instructions.includes('REQUIRED REFERENCE GAP:')); assert.ok(instructions.includes('OPTIONAL REFERENCE OMISSIONS:'));
    ctx.opts.skillInstructions = ids => registry.instructions(ids); ctx.opts.skillVersions = ids => registry.versions(ids);
    const t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: ['security-audit'] }, project).id);
    assert.equal(t.status, 'passed', t.summary); assert.equal(t.metrics.companionSchemaValidated, true); assert.ok(t.skillVersions[0].hash); assert.equal(t.metrics.guidance.mode, 'bounded-model-summaries');
  } finally { await ctx.cleanup(); }
});
test('shutdown awaits active cancellation and persists its terminal report', async () => {
  const ctx = await setup(async (_, __, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  try {
    const task = ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project); await new Promise(r => setTimeout(r, 20));
    await ctx.engine.shutdown(); const t = ctx.engine.get(task.id); assert.equal(t.status, 'cancelled');
    const saved = JSON.parse(await fs.readFile(path.join(t.reportDir, 'report.json'))); assert.equal(saved.status, 'cancelled');
  } finally { await ctx.cleanup(); }
});
test('restart marks persisted unfinished work partial', async () => {
  const ctx = await setup(async () => '{}');
  try {
    const id = '12345678-1234-1234-1234-123456789abc';
    await writeReport({ id, kind: 'audit', title: 'Interrupted', status: 'running', createdAt: '', projectName: '', projectId: '', input: { kind: 'audit', scopes: [], skillIds: [] }, logs: [], findings: [], coverage: { total: 1, reviewed: 0, skipped: 0 }, reportDir: path.join(ctx.opts.dataDir, 'tasks', id) });
    const engine = new TaskEngine(ctx.opts); await engine.init(); assert.equal(engine.get(id).status, 'partial');
  } finally { await ctx.cleanup(); }
});
test('clean six-phase source workflow passes and actual token usage survives report writes', async () => {
  let engine;
  const ctx = await setup(async () => { engine.recordUsage({ inputTokens: 12, outputTokens: 3, estimated: false }); return '{"findings":[],"summary":"Source facts","units":[{"path":"a/test.js","surface":"argument input","boundary":"input to evaluator","subsystem":"a","attackClass":"Injection","companionBlocks":[]}],"gaps":[],"clean":true,"reassignPaths":[]}'; }); engine = ctx.engine;
  try {
    const originalSettings = ctx.opts.settings;
    ctx.opts.settings = () => ({...originalSettings(),maxOutputTokens:32000});
    const t = await done(engine, engine.start({ kind: 'audit', scopes: ['a'], skillIds: [], objective: 'Check input boundary' }, project).id);
    assert.equal(t.status, 'passed', t.summary); assert.equal(t.metrics.workflow, 'complete'); assert.equal(t.metrics.companionSchemaValidated, true);
    assert.ok(t.metrics.usage.calls >= 8); assert.equal(t.metrics.usage.totalTokens, t.metrics.usage.calls * 15); assert.equal(t.metrics.usage.estimated, false);
    assert.ok(t.metrics.sourceSnapshot.files[0].hash); assert.equal(t.metrics.model.model, 'test');
    const metadata = JSON.parse(await fs.readFile(path.join(t.reportDir, 'run-metadata.json'))); assert.equal(metadata.run_status, 'complete'); assert.ok(!JSON.stringify(metadata).includes('private-api-key'));
    const security = await fs.readFile(path.join(t.reportDir, 'SECURITY-REPORT.md'), 'utf8');
    const general = await fs.readFile(path.join(t.reportDir, 'report.md'), 'utf8'); assert.notEqual(security, general); assert.match(security, /Run status: complete/); assert.match(security, /安全审计报告/);
    assert.match(await fs.readFile(path.join(t.reportDir, 'NEEDS-VALIDATION.md'), 'utf8'), /待验证问题/);
    assert.match(await fs.readFile(path.join(t.reportDir, 'architecture.md'), 'utf8'), /项目架构与侦察记录/);
    assert.equal((await fs.readdir(t.reportDir)).filter(name => name.toLowerCase() === 'report.md').length, 1);
  } finally { await ctx.cleanup(); }
});
test('resuming source audit reuses proven phases but repeats critics and rejects changed evidence',async()=>{
  let engine,cancelCritic=true,newCalls=0;
  const unit={path:'a/test.js',surface:'input',boundary:'caller to evaluator',subsystem:'a',attackClass:'Injection',companionBlocks:[]};
  const ctx=await setup(async(system,prompt)=>{
    newCalls++;engine.recordUsage({inputTokens:10,outputTokens:2,estimated:false});
    if(system.startsWith('Independently criticize source coverage')){assert.ok(prompt.includes('1: eval(userInput)'),'critic receives actual source, not only a manifest');if(cancelCritic){engine.cancel(engine.activeTask().id);throw new Error('cancelled for checkpoint');}}
    return JSON.stringify({summary:'source facts',units:[unit],findings:[],clean:true,gaps:[],reassignPaths:[]});
  });engine=ctx.engine;const initialSettings=ctx.opts.settings();ctx.opts.settings=()=>({...initialSettings,baseUrl:'http://127.0.0.1:1234'});
  const input={kind:'audit',engine:'security-audit',scopes:['a'],skillIds:[],contextBinding:{projectId:project.id,contextId:'same-context',generation:1}};
  try{
    const original=await done(engine,engine.start(input,project).id);assert.equal(original.status,'cancelled');
    const resume={...input,resumeFromTaskId:original.id};
    assert.throws(()=>engine.start(resume,{...project,files:[{...project.files[0],content:'changed()'},...project.files.slice(1)]}),/文件已变化/);
    assert.throws(()=>engine.start({...resume,contextBinding:{...input.contextBinding,contextId:'other-context'}},project),/上下文已变化/);
    cancelCritic=false;newCalls=0;
    const resumed=await done(engine,engine.start(resume,project).id);assert.equal(resumed.status,'passed',resumed.summary);assert.equal(newCalls,2);assert.ok(resumed.metrics.checkpoint.reusedPhases.length>=6);assert.equal(resumed.metrics.usage.totalTokens,24);assert.equal(resumed.metrics.checkpoint.inheritedUsageTokens,original.metrics.usage.totalTokens);assert.equal(engine.get(original.id).status,'cancelled');
    ctx.opts.skillVersions=async()=>[{id:'test',hash:'changed'}];newCalls=0;const rejected=await done(engine,engine.start(resume,project).id);assert.equal(rejected.status,'partial');assert.match(rejected.summary,/Skill 内容已变化/);assert.equal(newCalls,0);
  }finally{await ctx.cleanup();}
});

test('invalid critic JSON is retained and retried once without losing actual usage',async()=>{
  let engine,criticCalls=0;
  const unit={path:'a/test.js',surface:'input',boundary:'caller to evaluator',subsystem:'a',attackClass:'Injection',companionBlocks:[]};
  const ctx=await setup(async system=>{engine.recordUsage({inputTokens:10,outputTokens:2,estimated:false});if(system.startsWith('Independently criticize source coverage')&&++criticCalls===1)return '{invalid';return JSON.stringify({summary:'source',units:[unit],findings:[],clean:true,gaps:[],reassignPaths:[]});});engine=ctx.engine;
  try{const task=await done(engine,engine.start({kind:'audit',scopes:['a'],skillIds:[]},project).id);assert.equal(task.status,'passed',task.summary);assert.equal(criticCalls,2);assert.equal(task.metrics.modelResponseIssues.length,1);assert.equal(task.metrics.modelResponseIssues[0].responseExcerpt,'{invalid');assert.equal(task.metrics.usage.totalTokens,task.metrics.usage.calls*12);}finally{await ctx.cleanup();}
});

test('new units and newly required companion blocks stay deferred until a fresh guided assignment', async () => {
  const initial = { path: 'a/test.js', surface: 'input', boundary: 'input to evaluator', subsystem: 'a', attackClass: 'Injection', companionBlocks: [] };
  let scenario = 'new-unit';
  const ctx = await setup(async (system) => {
    if(system.startsWith('Fresh guided source reviewer.'))return '{}';
    if (system.includes('reconnaissance')) return JSON.stringify({ summary: 'Source facts', units: [initial], gaps: [] });
    if (system.startsWith('You are a security reviewer.')) return JSON.stringify({ findings: [], units: scenario === 'new-unit' ? [initial, { ...initial, surface: 'authorization input', boundary: 'caller to owner resource', attackClass: 'Access control', companionBlocks: ['WEB-PROTOCOL-AND-AUTH.md#Core discipline'] }] : [{ ...initial, companionBlocks: ['WEB-PROTOCOL-AND-AUTH.md#Core discipline'] }] });
    return '{"findings":[],"clean":true,"gaps":[],"reassignPaths":[]}';
  });
  try {
    let t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project).id);
    assert.equal(t.status, 'partial'); assert.equal(t.coverage.reviewed, 1); assert.equal(t.metrics.reviewedUnitAssignments.length, 1);
    let units = JSON.parse(await fs.readFile(path.join(t.reportDir, 'coverage-ledger.json')));
    assert.equal(units.find(u => u.attack_class === 'Injection').status, 'covered');
    const fresh = units.find(u => u.attack_class === 'Access control'); assert.equal(fresh.status, 'deferred'); assert.deepEqual(fresh.local_checks, []); assert.match(fresh.unresolved.join(' '), /fresh guided hunt/);
    scenario = 'new-companion';
    t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project).id); assert.equal(t.status, 'partial');
    units = JSON.parse(await fs.readFile(path.join(t.reportDir, 'coverage-ledger.json')));
    const changed = units.find(u => u.attack_class === 'Injection'); assert.equal(changed.status, 'deferred'); assert.ok(changed.selected_companion_blocks.length); assert.deepEqual(changed.local_checks, []);
  } finally { await ctx.cleanup(); }
});

test('coverage identity distinguishes files; unknown classes need a real Wildcard source review',async()=>{
  const units=['a/test.js','ab/other.js'].map(path=>({path,surface:'shared input',boundary:'caller to evaluator',subsystem:'shared',attackClass:'Injection',companionBlocks:[]}));let unknown=false;
  let wildcardReviewed=false,refuseWildcard=false;
  const ctx=await setup(async system=>{
    if(system.startsWith('You are a security reviewer.')&&system.includes('Required guidance ATTACK-CLASSES.md#Wildcard')){wildcardReviewed=true;if(refuseWildcard)return '{}';}
    if(system.includes('reconnaissance'))return JSON.stringify({summary:'source',units:[...units,{...units[0],surface:' shared input ',attackClass:'ATTACK-CLASSES.md#Injection'},...(unknown?['Unknown One','Unknown Two'].map(attackClass=>({...units[0],attackClass})):[])],gaps:[]});
    return '{"findings":[],"clean":true,"gaps":[],"reassignPaths":[]}';
  });
  const snapshot={...project,files:project.files.filter(f=>f.status==='read')};
  try{
    let task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['.'],skillIds:[]},snapshot).id);assert.equal(task.status,'passed',task.summary);assert.equal(task.metrics.companionSchemaValidated,true,JSON.stringify(task.metrics.validationErrors));
    let ledger=JSON.parse(await fs.readFile(path.join(task.reportDir,'coverage-ledger.json'),'utf8'));assert.equal(ledger.length,2);assert.equal(new Set(ledger.map(u=>u.coverage_id)).size,2);assert.ok(ledger.every(u=>u.surface.startsWith(u.starting_paths[0]+'#')));
    unknown=true;task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['.'],skillIds:[]},snapshot).id);assert.equal(task.status,'passed',task.summary);assert.equal(task.metrics.companionSchemaValidated,true,JSON.stringify(task.metrics.validationErrors));assert.equal(wildcardReviewed,true);
    ledger=JSON.parse(await fs.readFile(path.join(task.reportDir,'coverage-ledger.json'),'utf8'));assert.equal(ledger.length,3);assert.equal(new Set(ledger.map(u=>u.coverage_id)).size,3);assert.ok(task.metrics.assignmentCorrections.some(c=>c.originalClass==='Unknown One'));assert.ok(task.metrics.assignmentCorrections.some(c=>c.originalClass==='Unknown Two'));assert.equal(ledger.find(u=>u.attack_class==='Wildcard').status,'covered');
    refuseWildcard=true;task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['.'],skillIds:[]},snapshot).id);assert.equal(task.status,'partial');assert.ok(task.coverage.reviewed<task.coverage.total);
  }finally{await ctx.cleanup();}
});

test('source audit discloses binary policy exclusions but never exempts unreadable source',async()=>{
  const unit={path:'a/test.js',surface:'input',boundary:'caller to evaluator',subsystem:'a',attackClass:'Injection',companionBlocks:[]};
  const ctx=await setup(async()=>JSON.stringify({summary:'源码记录',units:[unit],findings:[],clean:true,gaps:[],reassignPaths:[]}));
  try{const snapshot={...project,files:[project.files[0],{path:'images/photo.png',size:500,status:'skipped',reason:'Binary or changing file excluded'},{path:'__pycache__',size:100,status:'skipped',reason:'Dependency or generated directory excluded'}]};let task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['.'],skillIds:[]},snapshot).id);assert.equal(task.status,'passed',task.summary);assert.equal(task.coverage.total,1);assert.equal(task.metrics.sourceExclusions.length,2);assert.match(await fs.readFile(path.join(task.reportDir,'report.md'),'utf8'),/二进制资源/);const ledger=JSON.parse(await fs.readFile(path.join(task.reportDir,'coverage-ledger.json'),'utf8'));assert.equal(ledger.find(u=>u.starting_paths.includes('images/photo.png')).status,'out_of_scope');snapshot.files.push({path:'too-large.js',size:3e6,status:'skipped',reason:'File exceeds 2 MB'});task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['.'],skillIds:[]},snapshot).id);assert.equal(task.status,'partial');assert.equal(task.coverage.total,2);assert.ok(!task.metrics.sourceExclusions.some(item=>item.path==='too-large.js'));}finally{await ctx.cleanup();}
});

test('newly discovered boundaries become covered only after an actual guided follow-up',async()=>{
  const unit={path:'a/test.js',surface:'input',boundary:'caller to evaluator',subsystem:'a',attackClass:'Injection',companionBlocks:[]};let followups=0;
  const ctx=await setup(async system=>{
    if(system.includes('reconnaissance'))return '{"summary":"source","units":[],"gaps":[]}';
    if(system.startsWith('You are a security reviewer.'))return JSON.stringify({findings:[],units:[unit]});
    if(system.startsWith('Fresh guided source reviewer.')){followups++;return '{"findings":[]}';}
    return '{"findings":[],"clean":true,"gaps":[],"reassignPaths":[]}';
  });
  try{const task=await done(ctx.engine,ctx.engine.start({kind:'audit',scopes:['a'],skillIds:[]},project).id);assert.equal(task.status,'passed',task.summary);assert.equal(followups,1);assert.ok(task.metrics.jobs.some(j=>j.phase==='guided-followup-a/test.js'&&j.status==='complete'));const ledger=JSON.parse(await fs.readFile(path.join(task.reportDir,'coverage-ledger.json'),'utf8'));assert.equal(ledger.find(u=>u.starting_paths.includes('a/test.js')).status,'covered');}finally{await ctx.cleanup();}
});

test('a failed test task retains its report and the next queued type still runs',async()=>{
  const ctx=await setup(async()=> '{}');ctx.engine.process=async args=>({code:args[0]==='run'&&args.includes('bad.js')?1:0,output:args[0]==='run'?(args.includes('bad.js')?'# pass 0\n# fail 1':'# pass 1\n# fail 0'):''});
  try{const first=ctx.engine.start({kind:'test',testType:'unit',scopes:['a'],skillIds:[],command:['node','bad.js']},project),second=ctx.engine.start({kind:'test',testType:'functional',scopes:['a'],skillIds:[],command:['node','good.js']},project);const failed=await done(ctx.engine,first.id),passed=await done(ctx.engine,second.id);assert.equal(failed.status,'failed');assert.equal(passed.status,'passed');assert.notEqual(failed.reportDir,passed.reportDir);assert.match(await fs.readFile(path.join(failed.reportDir,'report.md'),'utf8'),/发现问题/);assert.match(await fs.readFile(path.join(passed.reportDir,'report.md'),'utf8'),/正常/);}finally{await ctx.cleanup();}
});
test('OCR scans immutable staged content with joined scopes and zero-file preview blocks', async () => {
  const ctx = await setup(async () => '{}'); const calls = [];
  ctx.opts.ocr = async (args, cwd) => {
    calls.push(args); assert.notEqual(cwd, project.root); assert.equal(await fs.readFile(path.join(cwd, 'a/test.js'), 'utf8'), 'eval(userInput)');
    await assert.rejects(fs.access(path.join(cwd, '.env'))); await assert.rejects(fs.access(path.join(cwd, '.opencodereview.yaml')));
    assert.ok((await fs.readFile(path.join(cwd, '.git/HEAD'), 'utf8')).startsWith('ref:'));
    return { code: 0, stdout: args.includes('--preview') ? '{"reviewable_count":2,"files":[{},{}]}' : '{"findings":[]}', stderr: '' };
  };
  try {
    const snapshot = { ...project, files: [...project.files, { path: '.opencodereview.yaml', status: 'read', size: 20, content: 'malicious: config' }] };
    let t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', engine: 'ocr', scopes: ['a', 'ab'], skillIds: [] }, snapshot).id);
    assert.equal(t.status, 'partial'); assert.equal(calls.length, 2); assert.equal(calls[1][calls[1].indexOf('--path') + 1], 'a,ab');
    ctx.opts.ocr = async () => ({ code: 0, stdout: '{"reviewable_count":0,"files":[]}', stderr: '' });
    t = await done(ctx.engine, ctx.engine.start({ kind: 'audit', engine: 'ocr', scopes: ['a'], skillIds: [] }, project).id); assert.equal(t.status, 'blocked');
  } finally { await ctx.cleanup(); }
});
test('OCR comments, usage and incomplete coverage follow the real CLI response schema',async()=>{
  const ctx=await setup(async()=>{throw new Error('No direct model call expected');});
  let raw={status:'completed',summary:{files_reviewed:1,input_tokens:11,output_tokens:3},comments:[{path:'a/test.js',start_line:1,content:'需要核对动态执行的输入来源。',existing_code:'eval(userInput)',suggestion_code:'校验输入'}],warnings:[],tool_calls:{total:2,by_tool:{file_read:2}}};
  ctx.opts.ocr=async args=>({code:0,stdout:JSON.stringify(args.includes('--preview')?{reviewable_count:1,files:[{path:'a/test.js',will_review:true}]}:raw),stderr:''});
  try{
    let task=await done(ctx.engine,ctx.engine.start({kind:'audit',engine:'ocr',scopes:['a'],skillIds:[]},project).id);
    assert.equal(task.status,'partial');assert.equal(task.findings.length,1);assert.equal(task.findings[0].status,'needs_validation');assert.equal(task.metrics.usage.totalTokens,14);assert.deepEqual(task.coverage,{total:1,reviewed:1,skipped:0});assert.equal(task.metrics.ocrToolCalls.total,2);
    raw={...raw,status:'completed_with_errors',comments:[],warnings:[{type:'scan_subtask_error',file:'a/test.js',message:'budget exceeded'}]};
    task=await done(ctx.engine,ctx.engine.start({kind:'audit',engine:'ocr',scopes:['a'],skillIds:[]},project).id);
    assert.equal(task.status,'partial');assert.deepEqual(task.coverage,{total:1,reviewed:0,skipped:1});
    raw={...raw,status:'success',warnings:[]};task=await done(ctx.engine,ctx.engine.start({kind:'audit',engine:'ocr',scopes:['a'],skillIds:[]},project).id);assert.equal(task.status,'passed');assert.equal(task.coverage.reviewed,1);
  }finally{await ctx.cleanup();}
});

test('one command uses the selected test category as an independent argument',async()=>{
  const ctx=await setup(async()=>{throw new Error('No model call expected');}),settings=ctx.opts.settings();ctx.opts.settings=()=>({...settings,testExecution:'local'});
  try{const task=await done(ctx.engine,ctx.engine.start({kind:'test',testType:'automation',scopes:['a'],skillIds:[],generate:false,command:['node','-e',"require('node:assert/strict').equal(process.argv[1],'automation');console.log(JSON.stringify({auditDeskResults:true,passed:1,failed:0}));",'{testType}']},project).id);assert.equal(task.metrics.passed,1);assert.equal(task.metrics.exitCode,0);}finally{await ctx.cleanup();}
});

test('performance requires full measured load metrics; streamed artifacts are allowlisted', async () => {
  const ctx = await setup(async () => '{}'); let metrics = { p95Ms: 3 };
  ctx.engine.process = async args => ({ code: 0, output: args[0] === 'run' ? JSON.stringify({ auditDeskResults: true, passed: 1, failed: 0, metrics }) : '' });
  try {
    const input = { kind: 'test', testType: 'performance', scopes: ['a'], skillIds: [], command: ['node', 'load.js'], concurrency: 2, durationSeconds: 10, thresholdMs: 5 };
    let t = await done(ctx.engine, ctx.engine.start(input, project).id); assert.equal(t.status, 'partial');
    metrics = { throughputPerSecond: 10, errorRate: 0, p50Ms: 1, p95Ms: 3, p99Ms: 4, concurrency: 2, durationSeconds: 10, requests: 100 };
    t = await done(ctx.engine, ctx.engine.start(input, project).id); assert.equal(t.status, 'passed');
    metrics={...metrics,errorRate:0.1};t=await done(ctx.engine,ctx.engine.start(input,project).id);assert.equal(t.status,'failed');assert.match(t.summary,/错误率/);
    const payload = name => JSON.stringify({ auditDeskArtifact: true, name, mime: 'text/plain', base64: Buffer.from('console log').toString('base64') });
    const retained = await ctx.engine.streamArtifacts(t, payload('../escape') + '\n' + payload('browser.log')); assert.equal(retained.length, 1); assert.equal(retained[0].name, 'browser.log');
  } finally { await ctx.cleanup(); }
});

test('selected custom tools execute the model plan and audit receives bounded untrusted evidence', async () => {
  const prompts = [], executed = [];
  const ctx = await setup(async (system, prompt) => {
    prompts.push({ system, prompt });
    if (system.includes('Select necessary custom tools')) return JSON.stringify({ calls: [{ id: 'scanner', args: ['--offline'] }] });
    return '{"findings":[],"summary":"Source facts","units":[{"path":"a/test.js","surface":"input","boundary":"input to evaluator","subsystem":"a","attackClass":"Injection","companionBlocks":[]}],"gaps":[],"clean":true,"reassignPaths":[]}';
  });
  ctx.opts.customToolCatalog = async ids => { assert.deepEqual(ids, ['scanner']); return [{ id: 'scanner', name: 'Scanner', description: 'Local scan', command: ['scanner', '--json'] }]; };
  ctx.opts.executeCustomTool = async (id, args, snapshot, signal) => {
    executed.push({ id, args, snapshot, signal });
    return { toolName: 'Scanner', exitCode: 0, stdout: 'unique-tool-evidence\n' + 'x'.repeat(17000), stderr: '', durationMs: 12, reportDir: '/tool-report' };
  };
  try {
    const task = await done(ctx.engine, ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [], toolIds: ['scanner'], objective: 'Check inputs' }, project).id);
    assert.equal(executed.length, 1); assert.deepEqual(executed[0].args, ['--offline']); assert.equal(executed[0].snapshot.id, project.id);
    assert.equal(task.metrics.customTools[0].exitCode, 0); assert.equal(task.metrics.customTools[0].truncated, true);
    assert.ok(task.metrics.customTools.reduce((sum, row) => sum + row.stdout.length + row.stderr.length, 0) <= 16000);
    const event = task.metrics.flowEvents.find(event => event.tool === 'custom-tool'); assert.equal(event.status, 'completed'); assert.match(event.detail, /scanner/);
    const audit = prompts.find(row => row.system.includes('reconnaissance')); assert.match(audit.prompt, /unique-tool-evidence/); assert.match(audit.prompt, /untrusted/i); assert.ok(audit.prompt.length <= 20000);
    assert.equal(task.metrics.workflowPhases[0], 'index'); assert.ok(task.metrics.workflowPhases.includes('custom-tools'));
  } finally { await ctx.cleanup(); }
});

test('test generation receives selected custom tool evidence', async () => {
  let generated;
  const ctx = await setup(async (system, prompt) => {
    if (system.includes('Select necessary custom tools')) return '{"calls":[{"id":"scanner","args":[]}]}';
    generated = JSON.parse(prompt);
    return '{"plan":"Use scan evidence","command":["node","--test"],"files":[]}';
  });
  ctx.opts.customToolCatalog = async () => [{ id: 'scanner', name: 'Scanner', description: 'Local scan', command: ['scanner'] }];
  ctx.opts.executeCustomTool = async () => ({ toolName: 'Scanner', exitCode: 0, stdout: 'test-tool-evidence', stderr: '', durationMs: 1, reportDir: '/tool-report' });
  ctx.engine.process = async args => ({ code: 0, output: args[0] === 'run' ? '# pass 1\n# fail 0' : '' });
  try {
    const task = await done(ctx.engine, ctx.engine.start({ kind: 'test', testType: 'unit', scopes: ['a'], skillIds: [], toolIds: ['scanner'], generate: true }, project).id);
    assert.equal(task.status, 'passed', task.summary); assert.match(generated.customToolEvidence, /test-tool-evidence/); assert.match(generated.customToolEvidence, /untrusted/i);
  } finally { await ctx.cleanup(); }
});

test('invalid custom tool plans are rejected completely before any execution', async () => {
  let plan, calls = 0;
  const ctx = await setup(async () => JSON.stringify(plan));
  ctx.opts.customToolCatalog = async () => [{ id: 'scanner', name: 'Scanner', description: 'Local scan', command: ['scanner'] }];
  ctx.opts.executeCustomTool = async () => { calls++; throw Error('must not execute'); };
  try {
    for (plan of [
      { calls: [{ id: 'scanner', args: [] }, { id: 'unselected', args: [] }] },
      { calls: [{ id: 'scanner', args: ['bad\0arg'] }] },
      { calls: [{ id: 'scanner', args: Array(41).fill('arg') }] },
      { calls: [{ id: 'scanner', args: ['a'.repeat(8001)] }] },
      { calls: Array(6).fill({ id: 'scanner', args: [] }) }
    ]) {
      const task = await done(ctx.engine, ctx.engine.start({ kind: 'test', scopes: ['a'], skillIds: [], toolIds: ['scanner'], command: ['node', '--test'] }, project).id);
      assert.equal(task.status, 'blocked', task.summary); assert.match(task.summary, /custom tool/i); assert.equal(calls, 0);
    }
  } finally { await ctx.cleanup(); }
});

test('custom tool failures retain actual evidence and cannot turn into a passed test', async () => {
  const ctx = await setup(async () => '{"calls":[{"id":"scanner","args":[]}]}');
  ctx.opts.customToolCatalog = async () => [{ id: 'scanner', name: 'Scanner', description: 'Local scan', command: ['scanner'] }];
  ctx.opts.executeCustomTool = async () => ({ toolName: 'Scanner', exitCode: 2, stdout: '', stderr: 'real scanner failure', durationMs: 3, reportDir: '/tool-report' });
  let ran = false; ctx.engine.process = async () => { ran = true; return { code: 0, output: '# pass 99' }; };
  try {
    const task = await done(ctx.engine, ctx.engine.start({ kind: 'test', scopes: ['a'], skillIds: [], toolIds: ['scanner'], command: ['node', '--test'] }, project).id);
    assert.equal(task.status, 'partial'); assert.equal(ran, false); assert.equal(task.metrics.customTools[0].exitCode, 2); assert.match(task.metrics.customTools[0].stderr, /real scanner failure/);
    assert.equal(task.metrics.flowEvents.find(event => event.tool === 'custom-tool').status, 'failed');
  } finally { await ctx.cleanup(); }
});

test('active project helpers include cancelled cleanup and queued project work', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const ctx = await setup(async () => { entered(); await new Promise(resolve => { release = resolve; }); return '{}'; });
  try {
    const task = ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, project);
    await started;
    const snapshot = ctx.engine.activeTask(); assert.equal(snapshot.id, task.id); snapshot.title = 'mutated clone'; assert.notEqual(ctx.engine.activeTask().title, snapshot.title);
    const queued = ctx.engine.start({ kind: 'audit', scopes: ['a'], skillIds: [] }, { ...project, id: 'other-project' });
    assert.equal(ctx.engine.isProjectBusy('other-project'), true);
    ctx.engine.cancel(queued.id); assert.equal(ctx.engine.isProjectBusy('other-project'), false);
    ctx.engine.cancel(task.id); assert.equal(ctx.engine.activeTask().status, 'cancelled'); assert.equal(ctx.engine.isProjectBusy(project.id), true);
    release(); await ctx.engine.shutdown(); assert.equal(ctx.engine.activeTask(), undefined); assert.equal(ctx.engine.isProjectBusy(project.id), false);
  } finally { if (release) release(); await ctx.engine.shutdown(); await ctx.cleanup(); }
});

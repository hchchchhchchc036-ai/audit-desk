const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {unzipSync}=require('fflate');
const {writeReport}=require('../dist/reports');
const {createWordReport}=require('../dist/word-report');
const {buildChineseReport,reportSummary}=require('../dist/report-content');
const {chineseReportTask}=require('../dist/report-language');
const base=root=>({id:'test-report',kind:'test',title:'unit fixture',status:'passed',projectName:'权限模块',projectId:'project',createdAt:'2026-11-12T12:00:00Z',finishedAt:'2026-11-12T12:00:01Z',input:{kind:'test',testType:'unit',scopes:['src/auth'],skillIds:[],objective:'验证未登录用户不能访问管理接口'},logs:['# pass 1','# fail 0'],findings:[],coverage:{total:2,reviewed:0,skipped:0},metrics:{executionMode:'local',passed:1,failed:0,exitCode:0,elapsedMs:100,generatedPlan:'验证鉴权边界与合法请求',testCases:[{name:'未登录请求应被拒绝',status:'passed'}],command:['node','--test','tests/auth.test.js']},reportDir:root});

test('Word, Markdown and HTML share Chinese test results while JSON retains typed data',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'chinese-report-'));
  try{
    const task=base(root);await writeReport(task);
    const md=await fs.readFile(path.join(root,'report.md'),'utf8'),html=await fs.readFile(path.join(root,'report.html'),'utf8');
    assert.match(md,/测试了什么/);assert.match(md,/未登录请求应被拒绝/);assert.match(md,/正常/);assert.doesNotMatch(md,/## Findings|Status:|Recommendation:/);
    assert.match(html,/lang="zh-CN"/);assert.match(html,/正常/);
    const json=JSON.parse(await fs.readFile(path.join(root,'report.json'),'utf8'));assert.equal(json.status,'passed');assert.equal(typeof json.metrics.passed,'number');
    const buffer=await createWordReport(task);assert.equal(buffer.subarray(0,2).toString(),'PK');
    const zip=unzipSync(buffer);assert.ok(zip['[Content_Types].xml']);assert.ok(zip['word/styles.xml']);
    const xml=Buffer.from(zip['word/document.xml']).toString();assert.match(xml,/未登录请求应被拒绝/);assert.match(xml,/正常/);assert.match(xml,/w:tbl/);assert.match(xml,/w:pgSz[^>]*11906/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unexecuted, failed and incomplete tests never get a normal conclusion',()=>{
  for(const status of ['queued','running','blocked','partial','cancelled','failed']){
    const task={...base('/unused'),status};assert.ok(!reportSummary(task).startsWith('正常'));
  }
});

test('incomplete checks group real reasons without replacing them with repeated generic prose',()=>{
  const task=base('/unused');task.status='partial';task.metrics.workflowGaps=['recon: input/token budget cannot fund call and reserves','discovery: input/token budget cannot fund call and reserves','guidance-summary-1: TimeoutError: aborted due to timeout','unassigned or unreviewed coverage units remain deferred'];
  const sections=buildChineseReport(task),summary=sections.find(s=>s.title==='尚未完成的检查'),raw=sections.find(s=>s.title==='未完成检查的原始记录');
  assert.equal(summary.table.rows.length,3);assert.deepEqual(summary.table.rows.map(r=>r[1]),['2','1','1']);
  assert.match(raw.code,/guidance-summary-1/);assert.match(raw.code,/input\/token budget/);assert.doesNotMatch(JSON.stringify(sections),/存在未完成或未验证的检查项，参见后附原始执行记录/);
});

test('audit report explains exact locations, dependency evidence, issue chain and remediation',async()=>{
  const task={...base('/unused'),kind:'audit',status:'failed',input:{kind:'audit',scopes:['src'],skillIds:[]},findings:[{path:'src/router.js',line:12,title:'未校验用户身份就调用管理操作',status:'confirmed',detail:'独立源码验证已确认权限边界缺失',rootCause:'路由没有检查登录状态，将外部输入直接传给管理服务',impact:'未登录调用方可能读取管理数据',recommendation:'在 router.js:12 增加身份校验，并在 service.js:8 复核权限，补充未登录请求测试',chainAnalysis:'外部请求经过路由传入服务，最终进入数据读取函数',evidence:'service.read(req.query)',dependencies:[{name:'service',kind:'module',file:'src/router.js',line:1,relationship:'路由依赖服务模块执行读取',evidence:"const service = require('./service')"}],trace:[{kind:'entrypoint',file:'src/router.js',line:12,description:'接收外部请求',excerpt:'req.query'},{kind:'propagation',file:'src/service.js',line:8,description:'将参数传给读取函数',excerpt:'read(input)'},{kind:'sink',file:'src/db.js',line:3,description:'读取受保护数据',excerpt:'db.read(input)'}]}]};
  const body=JSON.stringify(buildChineseReport(task));for(const needle of ['src/router.js:12','问题原因','内部模块','依赖','关键操作','增加身份校验','已确认的源码问题链'])assert.ok(body.includes(needle),needle);
  task.findings[0].status='needs_validation';assert.ok(JSON.stringify(buildChineseReport(task)).includes('待验证的关联路径'));
  const xml=Buffer.from(unzipSync(await createWordReport(task))['word/document.xml']).toString();assert.match(xml,/问题原因/);assert.match(xml,/修改建议/);assert.match(xml,/src\/router.js:12/);
});

test('legacy English analysis translates once, caches results and preserves source facts and verdicts',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'report-translation-'));
  try{
    const task={...base(root),kind:'audit',findings:[{path:'a.js',line:2,title:'Unsafe authorization',detail:'No access check',rootCause:'Trusting user input',recommendation:'Check authorization',evidence:'read(userInput)',status:'needs_validation'}]};
    const original=structuredClone(task);let calls=0;
    const translated=await chineseReportTask(task,async(system,prompt)=>{calls++;return JSON.stringify({translations:JSON.parse(prompt).map(field=>({key:field.key,text:'中文说明：'+field.key}))});});
    assert.ok(calls>0);assert.equal(translated.findings[0].status,'needs_validation');assert.equal(translated.findings[0].evidence,'read(userInput)');assert.equal(translated.findings[0].line,2);assert.deepEqual(task,original);
    const cached=await chineseReportTask(task,async()=>{throw new Error('cache must avoid another model call');});assert.equal(cached.findings[0].title,translated.findings[0].title);
    assert.match(await fs.readFile(path.join(root,'report-zh.json'),'utf8'),/中文说明/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('invalid Chinese translation cannot change verdicts or replace original evidence',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'report-invalid-'));
  try{
    const task={...base(root),findings:[{path:'a.js',line:1,title:'English title',detail:'English detail',status:'needs_validation'}]};
    await assert.rejects(chineseReportTask(task,async()=>'{"status":"passed","translations":[]}'),/完整/);assert.equal(task.findings[0].status,'needs_validation');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

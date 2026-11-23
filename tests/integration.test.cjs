const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('model endpoint and settings reject unsafe transports and invalid limits', () => {
  const { validateSettings, endpoint } = require('../dist/model.js');
  assert.throws(() => validateSettings({ baseUrl:'http://example.com/v1', model:'x' }), /HTTPS/);
  assert.throws(() => validateSettings({ baseUrl:'file:///tmp/key', model:'x' }), /HTTPS/);
  const s = validateSettings({protocol:'openai',baseUrl:'http://127.0.0.1:1234/v1',model:'local',maxInputChars:2000});
  assert.equal(endpoint(s),'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(endpoint({...s,baseUrl:s.baseUrl+'/chat/completions'}),'http://127.0.0.1:1234/v1/chat/completions');
});

test('official DeepSeek thinking mode is explicit and never leaks into other providers',async()=>{
  const {callModel,validateSettings}=require('../dist/model');const original=global.fetch;const bodies=[];
  global.fetch=async(_url,options)=>{bodies.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'正常'}}],usage:{prompt_tokens:1,completion_tokens:1}}),{status:200});};
  try{const settings=validateSettings({baseUrl:'https://api.deepseek.com',model:'deepseek-flash'});await callModel(settings,'s','p');assert.equal(bodies.at(-1).thinking.type,'disabled');await callModel({...settings,thinkingMode:'enabled'},'s','p');assert.equal(bodies.at(-1).thinking.type,'enabled');await callModel({...settings,thinkingMode:'auto'},'s','p');assert.equal(bodies.at(-1).thinking,undefined);await callModel({...settings,baseUrl:'https://other.example/v1'},'s','p');assert.equal(bodies.at(-1).thinking,undefined);}finally{global.fetch=original;}
});

test('model timeout retries twice, continues after recovery, and respects cancellation and other errors',async()=>{
  const {retryModelTimeout}=require('../dist/model');let attempts=[];
  assert.equal(await retryModelTimeout(async attempt=>{attempts.push(attempt);if(attempt<2)throw Object.assign(new Error('timeout'),{code:'MODEL_TIMEOUT'});return '恢复后继续';}),'恢复后继续');assert.deepEqual(attempts,[0,1,2]);
  let count=0;await assert.rejects(retryModelTimeout(async()=>{count++;throw Object.assign(new Error('timeout'),{code:'MODEL_TIMEOUT'});}),error=>error.code==='MODEL_TIMEOUT'&&/重试 2 次/.test(error.message));assert.equal(count,3);
  count=0;await assert.rejects(retryModelTimeout(async()=>{count++;throw Object.assign(new Error('HTTP 401'),{code:'MODEL_HTTP'});}));assert.equal(count,1);
  const controller=new AbortController();count=0;await assert.rejects(retryModelTimeout(async()=>{count++;controller.abort();throw Object.assign(new Error('timeout'),{code:'MODEL_TIMEOUT'});},controller.signal));assert.equal(count,1);
});

test('model timeout covers an unfinished response body and reports configured deadline', async () => {
  const {callModel,validateSettings}=require('../dist/model.js');
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"choices":');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const settings=validateSettings({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'slow-fixture',timeoutSeconds:5});
    await assert.rejects(callModel(settings,'system','prompt'),error=>error.code==='MODEL_TIMEOUT'&&/5 秒/.test(error.message));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('shared model client sends selected protocol/key and parses actual response', async () => {
  const { callModel, validateSettings } = require('../dist/model.js');
  let received;
  const server = http.createServer(async (req,res) => {
    let b=''; for await (const x of req) b+=x;
    received={url:req.url,auth:req.headers.authorization,body:JSON.parse(b)};
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:'verified'}}],usage:{prompt_tokens:41,completion_tokens:3}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const s=validateSettings({protocol:'openai',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'my-model',apiKey:'test-secret'});
    let usage;
    assert.equal(await callModel(s,'system','source',undefined,u=>usage=u),'verified');
    assert.deepEqual(usage,{inputTokens:41,outputTokens:3,estimated:false});
    assert.equal(received.auth,'Bearer test-secret');
    assert.equal(received.body.model,'my-model');
    assert.equal(received.url,'/v1/chat/completions');
  } finally { await new Promise(r=>server.close(r)); }
});

test('model usage is recorded even when response is truncated or has only reasoning', async () => {
  const {callModel,validateSettings,parseModelJson,estimateTokens}=require('../dist/model.js');
  const http=require('node:http');let content=null,reason='length';
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content,reasoning_content:'hidden'},finish_reason:reason}],usage:{prompt_tokens:100,completion_tokens:4096}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const s=validateSettings({baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture'});assert.equal(s.testExecution,'local');
    let usage;await assert.rejects(callModel(s,'system','prompt',undefined,u=>usage=u),/截断/);assert.equal(usage.outputTokens,4096);
    reason='stop';await assert.rejects(callModel(s,'system','prompt',undefined,u=>usage=u),/有效文本/);assert.equal(usage.inputTokens,100);
    assert.deepEqual(parseModelJson('```json\n{"ok":true}\n```'),{ok:true});assert.throws(()=>parseModelJson('{"broken":'),/完整 JSON/);
    assert.ok(estimateTokens('中文 source')<Buffer.byteLength('中文 source'));
  }finally{await new Promise(r=>server.close(r));}
});

test('undecryptable API key does not block startup or erase ciphertext and can be replaced', async () => {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const {SettingsStore}=require('../dist/store.js');
  const {defaults}=require('../dist/model.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vault-recovery-'));
  try{
    const ciphertext=Buffer.from('prior-windows-context').toString('base64');
    await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({...defaults,model:'preserved-model',encryptedKey:ciphertext}));
    const store=new SettingsStore(root,{isEncryptionAvailable:()=>true,decryptString:()=>{throw new Error('DPAPI failure');},encryptString:s=>Buffer.from('new-encrypted:'+s)});
    await store.init();assert.equal(store.get().model,'preserved-model');assert.equal(store.public().hasApiKey,false);assert.match(store.public().keyError,/重新填写/);
    assert.throws(()=>store.assertKeyAvailable(),/重新填写/);
    await store.save({tokenBudget:300000});
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'settings.json'),'utf8')).encryptedKey,ciphertext);
    await store.save({apiKey:'replacement-secret'});assert.equal(store.public().keyError,undefined);assert.equal(store.get().apiKey,'replacement-secret');
    assert.doesNotThrow(()=>store.assertKeyAvailable());assert.ok(!(await fs.readFile(path.join(root,'settings.json'),'utf8')).includes('replacement-secret'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('OCR shares model through environment without key arguments or global config', () => {
  const { ocrEnvironment }=require('../dist/ocr.js');
  const {validateSettings}=require('../dist/model.js');
  const env=ocrEnvironment(validateSettings({protocol:'openai',baseUrl:'http://127.0.0.1:1234/v1',model:'same-model',apiKey:'secret'}),'C:\\scratch');
  assert.equal(env.OCR_LLM_MODEL,'same-model');
  assert.equal(env.OCR_LLM_TOKEN,'secret');
  assert.equal(env.OCR_LLM_URL,'http://127.0.0.1:1234/v1');
  assert.equal(env.USERPROFILE,'C:\\scratch');
  assert.equal(env.GITHUB_TOKEN,undefined);
  const anthropic=ocrEnvironment(validateSettings({protocol:'anthropic',baseUrl:'https://api.anthropic.com/v1/messages',model:'a'}),'C:\\scratch');
  assert.equal(anthropic.OCR_LLM_URL,'https://api.anthropic.com');
});

test('process output masks credentials split across chunks',async()=>{
  const {runProcess}=require('../dist/ocr.js');const logs=[];
  const result=await runProcess(process.execPath,['-e',"process.stdout.write('custom-provider-');setTimeout(()=>process.stdout.write('secret-12345'),30)"],{secret:'custom-provider-secret-12345',onLog:l=>logs.push(l)});
  assert.equal(result.stdout,'[REDACTED]');assert.equal(logs.join(''),'[REDACTED]');
});

test('telemetry reports real host bounds and labels estimated token use',()=>{
  const {SystemMonitor,UsageMeter}=require('../dist/telemetry.js');
  const sample=new SystemMonitor().read();
  assert.ok(sample.memory.totalBytes>0);assert.ok(sample.memory.percent>=0&&sample.memory.percent<=100);
  assert.ok(sample.cpu.cores.length>0&&sample.cpu.percent>=0&&sample.cpu.percent<=100);
  const usage=new UsageMeter();usage.add({inputTokens:100,outputTokens:20,estimated:false});
  assert.equal(usage.snapshot(1000).contextPercent,10);assert.equal(usage.snapshot().totalTokens,120);
  usage.add({inputTokens:10,outputTokens:5,estimated:true});assert.equal(usage.snapshot().estimated,true);
});

test('battery data preserves actual percentage and distinguishes desktop from unavailable',()=>{
  const {parseBattery}=require('../dist/telemetry.js');
  assert.deepEqual(parseBattery('[]'),{present:false,percent:null,charging:false,message:'AC / 无电池'});
  assert.deepEqual(parseBattery('{"EstimatedChargeRemaining":72,"BatteryStatus":6}'),{present:true,percent:72,charging:true});
  assert.equal(parseBattery('{"EstimatedChargeRemaining":255,"BatteryStatus":1}').percent,null);
});

test('store encrypts key and keeps it out of public settings', async () => {
  const {SettingsStore}=require('../dist/store.js');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'audit-store-'));
  const vault={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).reverse(),decryptString:b=>Buffer.from(b).reverse().toString()};
  try {
    const store=new SettingsStore(tmp,vault);
    await store.init();
    await store.save({baseUrl:'https://example.org/v1',model:'x',apiKey:'test-key-unique'});
    const raw=await fs.readFile(path.join(tmp,'settings.json'),'utf8');
    assert.equal(raw.includes('test-key-unique'),false);
    assert.equal(store.public().apiKey,undefined);
    assert.equal(store.public().hasApiKey,true);
    await store.save({model:'next',apiKey:''});
    assert.equal(store.get().apiKey,'test-key-unique');
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
});

const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=path.join(root,'.runtime',`context-check-${Date.now()}`);
  let failSummary=false,application,releaseSelection,selectionStarted=false;const calls=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const data=JSON.parse(raw),system=data.messages[0].content,prompt=data.messages.at(-1).content;
    calls.push({system,prompt,maxTokens:data.max_tokens});res.setHeader('Content-Type','application/json');
    if(system.includes('Select necessary custom tools')){selectionStarted=true;await new Promise(resolve=>releaseSelection=resolve);}
    if(failSummary){res.statusCode=500;res.end(JSON.stringify({error:{message:'deliberate fixture failure'}}));return;}
    let content='# Alpha handoff\nScope: 界面测试 项目. Verified unit test; next: review auth boundary.';
    if(system.includes('Select necessary custom tools'))content=JSON.stringify({calls:[{id:JSON.parse(prompt).tools[0].id,args:[]}]});
    else if(system.includes('test')||prompt.includes('generated-tests'))content=JSON.stringify({plan:'reuse auth test',command:['node','--test','tests/auth.test.js'],files:[]});
    res.end(JSON.stringify({choices:[{message:{content}}],usage:{prompt_tokens:32,completion_tokens:12}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={...process.env,AUDIT_DESK_DATA:dataDir,AUDIT_DESK_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
  try{
    application=await electron.launch({...(process.env.AUDIT_DESK_EXECUTABLE?{executablePath:process.env.AUDIT_DESK_EXECUTABLE,args:[]}:{args:[root]}),env,timeout:30000});const page=await application.firstWindow();
    await page.waitForSelector('h1');
    const invoke=(action,payload)=>page.evaluate(({action,payload})=>window.audit.invoke(action,payload),{action,payload});
    const importFolder=async folder=>{
      await application.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);
      await invoke('project:import');return invoke('state');
    };
    await invoke('settings:save',{model:'context-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindowTokens:1000000,maxInputChars:200000});
    const a=await importFolder(path.join(root,'.runtime','界面测试 项目'));
    const b=await importFolder(path.join(root,'scripts','fixtures','live-project'));
    assert.notEqual(a.context.id,b.context.id);
    const tool=await invoke('tool:save',{name:'Scope probe',description:'Verify indexed project scope during testing',enabled:true,command:['node','-e',"console.log(require('fs').existsSync('tests/auth.test.js')?'A_SCOPE':'B_SCOPE')"]});
    await invoke('project:select',{id:a.project.id});
    const task=await invoke('task:start',{kind:'test',scopes:['.'],skillIds:[],toolIds:[tool.id],testType:'unit',generate:true});
    const waitingDeadline=Date.now()+10000;while(!selectionStarted&&Date.now()<waitingDeadline)await page.waitForTimeout(10);
    assert.ok(selectionStarted,'first model request is in flight');
    await page.evaluate(()=>refresh());
    await page.emulateMedia({reducedMotion:'no-preference'});
    const runningNode=page.locator('.live-node.node-running').first();
    assert.equal(await runningNode.evaluate(node=>getComputedStyle(node).animationName),'workflow-stream');
    assert.equal(await page.locator('.trace-running .trace-code').first().evaluate(node=>getComputedStyle(node,'::after').animationName),'workflow-pulse');
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await runningNode.evaluate(node=>getComputedStyle(node).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const clock=page.locator('.trace-running .trace-duration').first();
    await page.waitForTimeout(1100);
    assert.match(await clock.textContent(),/等待 \d+s \/ 上限 120s/);
    await page.locator('#open-context').click();
    assert.equal(await page.locator('#compress-context').isDisabled(),true);
    assert.match(await page.locator('#context-metadata').textContent(),/项目任务运行中/);
    await page.locator('#close-context').click();
    await invoke('settings:save',{maxOutputTokens:8192});
    releaseSelection();
    await assert.rejects(invoke('context:reset'),/运行|任务|等待|正在|busy/i);
    await invoke('project:select',{id:b.project.id});
    let done;const deadline=Date.now()+90000;
    while(Date.now()<deadline){const state=await invoke('state');done=state.tasks.find(t=>t.id===task.id);if(done&&!['running','queued'].includes(done.status))break;await page.waitForTimeout(250);}
    assert.equal(done.status,'passed',JSON.stringify(done));
    assert.equal(done.input.contextBinding.projectId,a.project.id);
    assert.ok(done.metrics.flowEvents.some(e=>e.tool==='custom-tool'));
    const bAfter=await invoke('context:get');assert.equal(bAfter.messages.length,0);assert.equal(bAfter.usage.calls,0);
    const bTool=await invoke('tool:run',{id:tool.id});assert.match(bTool.stdout,/B_SCOPE/);
    await invoke('project:select',{id:a.project.id});
    const aAfter=await invoke('context:get');assert.ok(aAfter.usage.calls>=2);assert.ok(aAfter.messages.length>0);
    await page.evaluate(()=>refresh());
    assert.equal(await page.locator('.node-running, .trace-running').count(),0,'activity animation stops with the task');
    assert.ok((await invoke('telemetry')).usage.totalTokens>0);
    assert.equal(done.metrics.executionMode,'local');
    assert.equal(calls[0].maxTokens,4096,'in-flight request retains its original limit');
    assert.equal(calls[1].maxTokens,8192,'next request uses newly saved output limit during the same task');
    assert.ok(done.metrics.flowEvents.some(e=>e.detail?.includes('max_output_tokens=8192')));
    const compressed=await invoke('context:compress');assert.equal(compressed.id,a.context.id);
    const reset=await invoke('context:reset');assert.notEqual(reset.id,a.context.id);assert.equal(reset.generation,2);
    assert.match(await fs.readFile(reset.handoffPath,'utf8'),/Alpha handoff/);
    assert.ok(!calls.filter(c=>c.system.includes('交接')).some(c=>c.prompt.includes('B_SCOPE')));
    failSummary=true;await assert.rejects(invoke('context:compress'));failSummary=false;
    const preserved=await invoke('context:get');assert.equal(preserved.id,reset.id);assert.equal(preserved.summary,reset.summary);
    const telemetry=await invoke('telemetry');assert.equal(telemetry.context.capacityTokens,1000000);
    assert.equal(await page.locator('#chat-dialog, #open-chat, [data-tab="chat"]').count(),0);
    const result={passed:true,checks:['distinct project contexts','1M synchronized capacity','model-selected project-copy tool','running context reset blocked','task context pinned across project switching','usage isolated by project','manual tool reads selected project only','compression preserves identity','reset saves handoff and creates generation','model failure preserves context','no chat UI'],modelCalls:calls.length};
    await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile(path.join(root,'artifacts','context-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{releaseSelection?.();if(application)await application.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

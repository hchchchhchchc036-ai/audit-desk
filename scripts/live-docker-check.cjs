const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {TaskEngine}=require('../dist/engine.js');
const {indexProject}=require('../dist/project.js');
const {validateSettings}=require('../dist/model.js');
(async()=>{
  const root=path.resolve(__dirname,'..');
  const project=await indexProject(path.join(__dirname,'fixtures','live-project'));
  const dataDir=path.join(root,'artifacts','live-docker');
  const settings=validateSettings({model:'not-used-by-existing-tests',containerImage:'node:22-bookworm-slim',testExecution:'docker'});
  const engine=new TaskEngine({dataDir,settings:()=>settings,modelCall:async()=>{throw new Error('No model calls in live fixture test');},skillInstructions:async()=>'',skillVersions:async()=>[],ocr:async()=>{throw new Error('No OCR calls in fixture');},emit:()=>{}});
  await engine.init();
  const results=[];
  for(const [testType,file]of[['unit','tests/unit.test.js'],['functional','tests/functional.test.js'],['performance','tests/performance.js']]){
    const task=engine.start({kind:'test',scopes:['.'],skillIds:[],testType,generate:false,command:['node',...(testType==='performance'?[]:['--test']),file],durationSeconds:testType==='performance'?3:30,concurrency:2,thresholdMs:1000},project);
    const end=Date.now()+120000;
    let result;
    while(Date.now()<end){result=engine.get(task.id);if(!['queued','running'].includes(result.status))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(result.status,'passed',JSON.stringify({type:testType,status:result.status,summary:result.summary,logs:result.logs},null,2));
    results.push({id:result.id,type:testType,status:result.status,metrics:result.metrics,report:path.relative(root,path.join(result.reportDir,'report.html'))});
  }
  await fs.writeFile(path.join(root,'artifacts','live-docker-check.json'),JSON.stringify({passed:true,results},null,2));
  console.log(JSON.stringify({passed:true,results:results.map(({type,status,report})=>({type,status,report}))}));
})().catch(e=>{console.error(e);process.exitCode=1;});

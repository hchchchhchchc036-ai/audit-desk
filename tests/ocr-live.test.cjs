const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {OcrManager,ocrEnvironment,runProcess}=require('../dist/ocr.js');
const {validateSettings}=require('../dist/model.js');

test('installed OCR calls the same OpenAI and Anthropic model endpoints',async t=>{
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'audit-ocr-live-'));
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);seen.push({url:req.url,body,authorization:req.headers.authorization,key:req.headers['x-api-key']});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url.includes('messages')?{id:'fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:1}}:{id:'fixture',object:'chat.completion',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const settings=validateSettings({baseUrl:base+'/v1',model:'shared-fixture-model',apiKey:'fixture-key'});
    const manager=new OcrManager(scratch,()=>settings);const tool=await manager.detect();
    if(!tool.available){t.skip('OCR is not installed; installer is separately available');return;}
    for(const protocol of ['openai','anthropic']){
      const s=validateSettings({...settings,protocol,baseUrl:base+'/v1'});
      const result=await runProcess(tool.path,['llm','test'],{env:ocrEnvironment(s,scratch),cwd:scratch,timeoutMs:15000,secret:s.apiKey});
      assert.equal(result.code,0,result.stderr);assert.ok(result.stdout.includes('successful')||result.stdout.includes('success'));
    }
    assert.equal(seen[0].url,'/v1/chat/completions');assert.equal(seen[1].url,'/v1/messages');
    assert.ok(seen.every(x=>x.body.model==='shared-fixture-model'));
    assert.equal(seen[0].authorization,'Bearer fixture-key');assert.equal(seen[1].key,'fixture-key');
  }finally{await new Promise(r=>server.close(r));await fs.rm(scratch,{recursive:true,force:true});}
});

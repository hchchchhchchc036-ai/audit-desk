const {_electron:electron}=require('playwright');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..');
  const env={...process.env,AUDIT_DESK_SMOKE:'1'};delete env.AUDIT_DESK_DATA;delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({executablePath:process.env.AUDIT_DESK_EXECUTABLE||path.join(root,require('../package.json').build.directories.output,'win-unpacked','Audit Desk.exe'),args:[],env,timeout:30000});
    const page=await app.firstWindow();await page.waitForSelector('h1',{timeout:30000});
    const dataDir=await app.evaluate(({app})=>app.getPath('userData'));
    assert.equal(dataDir,path.join(process.env.APPDATA,'Audit Desk'));
    const state=await page.evaluate(()=>window.audit.invoke('state'));
    assert.equal(state.skills.length,5);assert.ok(Array.isArray(state.projects));
    if(state.settings.keyError){
      await page.locator('[data-tab="settings"]').click();
      assert.match(await page.locator('#apiKey').getAttribute('placeholder'),/无法解密/);
      await assert.rejects(page.evaluate(()=>window.audit.invoke('model:test')),/重新填写/);
    }
    assert.equal(await page.locator('#chat-dialog, #open-chat, [data-tab="chat"]').count(),0);
    const result={passed:true,dataDir,keyRecoveryNeeded:!!state.settings.keyError,checks:['packaged app starts with actual default AppData','workspace initialized','five bundled Skills loaded','no chat UI','unreadable key offers recovery without startup failure']};
    await fs.writeFile(path.join(root,'artifacts','startup-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
test('custom tools require explicit argv and preserve enabled state without host execution',async()=>{
  const {CustomToolRegistry}=require('../dist/custom-tools.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'audit-tools-'));
  try{
    const registry=new CustomToolRegistry(root);await registry.init();
    await assert.rejects(()=>registry.save({name:'bad',description:'bad',command:'echo hello'}),/数组|argv/);
    const tool=await registry.save({name:'Node test',description:'run test in container',command:['node','--test'],enabled:true});
    assert.ok(tool.id);assert.deepEqual(tool.command,['node','--test']);
    await registry.setEnabled(tool.id,false);
    assert.equal((await registry.list())[0].enabled,false);
    await assert.rejects(()=>registry.getEnabled([tool.id]),/未启用/);
    await assert.rejects(()=>registry.save({...tool,command:['node'],image:'--privileged'}),/镜像/);
    await registry.remove(tool.id);assert.equal((await registry.list()).length,0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

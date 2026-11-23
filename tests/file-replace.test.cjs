const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {replaceFile}=require('../dist/file-replace');

test('EXDEV fallback creates and replaces files, restores old data on copy failure',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'replace-'));
  const source=path.join(root,'source'),target=path.join(root,'target');
  const rename=fs.rename,copy=fs.copyFile;
  fs.rename=async()=>{throw Object.assign(new Error('cross-device'),{code:'EXDEV'});};
  try{
    await fs.writeFile(source,'first');await replaceFile(source,target);
    assert.equal(await fs.readFile(target,'utf8'),'first');
    await fs.writeFile(source,'second');await replaceFile(source,target);
    assert.equal(await fs.readFile(target,'utf8'),'second');
    await fs.writeFile(source,'third');
    fs.copyFile=async(a,b,flags)=>{if(a===source){await fs.writeFile(b,'partial');throw Object.assign(new Error('disk failure'),{code:'EIO'});}return copy(a,b,flags);};
    await assert.rejects(replaceFile(source,target),/disk failure/);
    assert.equal(await fs.readFile(target,'utf8'),'second');assert.equal(await fs.readFile(source,'utf8'),'third');
    assert.deepEqual((await fs.readdir(root)).sort(),['source','target']);
    fs.copyFile=copy;fs.rename=async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});};
    await assert.rejects(replaceFile(source,target),/denied/);
    assert.equal(await fs.readFile(target,'utf8'),'second');
  }finally{fs.rename=rename;fs.copyFile=copy;await fs.rm(root,{recursive:true,force:true});}
});

import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import http from 'node:http';
import {canRead} from '../src/auth.js';
test('HTTP record route enforces ownership boundary',async()=>{
  const server=http.createServer((req,res)=>{
    const user={id:Number(req.headers['x-fixture-user'])};
    res.statusCode=canRead(user,{ownerId:1})?200:403;
    res.end(res.statusCode===200?'fixture-record':'forbidden');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const url=`http://127.0.0.1:${server.address().port}/record`;
    assert.equal((await fetch(url,{headers:{'x-fixture-user':'1'}})).status,200);
    assert.equal((await fetch(url,{headers:{'x-fixture-user':'2'}})).status,403);
  }finally{await new Promise(r=>server.close(r));}
});

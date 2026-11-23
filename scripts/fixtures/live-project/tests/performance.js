import http from 'node:http';
import {performance} from 'node:perf_hooks';
const concurrency=2,durationSeconds=3;
const server=http.createServer((_req,res)=>res.end('fixture-health'));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/health`;
const samples=[];let errors=0,requests=0;
const start=performance.now(),deadline=start+durationSeconds*1000;
try{
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(performance.now()<deadline){
      const begin=performance.now();
      try{const r=await fetch(url);await r.text();if(!r.ok)errors++;}catch{errors++;}
      samples.push(performance.now()-begin);requests++;
    }
  }));
}finally{await new Promise(r=>server.close(r));}
samples.sort((a,b)=>a-b);
const percentile=q=>samples[Math.min(samples.length-1,Math.floor(samples.length*q))]||0;
const elapsed=(performance.now()-start)/1000;
console.log(JSON.stringify({auditDeskResults:true,passed:errors===0?1:0,failed:errors?1:0,metrics:{throughputPerSecond:requests/elapsed,errorRate:requests?errors/requests:1,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),concurrency,durationSeconds,requests}}));

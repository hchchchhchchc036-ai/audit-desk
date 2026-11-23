import os from 'node:os';
import type { ModelUsage } from './model';
import path from 'node:path';
import { runProcess } from './ocr';

export type BatteryReading = {present:boolean|null;percent:number|null;charging:boolean|null;message?:string};
export function parseBattery(raw:string):BatteryReading {
  const data=JSON.parse(raw||'[]');
  const batteries=Array.isArray(data)?data:data?[data]:[];
  if(!batteries.length)return {present:false,percent:null,charging:false,message:'AC / 无电池'};
  const values=batteries.map((b:any)=>b.EstimatedChargeRemaining).filter((n:any)=>Number.isFinite(n)&&n>=0&&n<=100);
  const states=batteries.map((b:any)=>Number(b.BatteryStatus));
  return {present:true,percent:values.length?Math.round(values.reduce((a:number,b:number)=>a+b,0)/values.length):null,charging:states.some((s:number)=>[6,7,8,9].includes(s))};
}
export class BatteryMonitor {
  private value:BatteryReading={present:null,percent:null,charging:null};
  private lastCheck=0;
  private checking=false;
  read():BatteryReading {
    if(Date.now()-this.lastCheck>30000&&!this.checking)void this.refresh();
    return {...this.value};
  }
  private async refresh() {
    this.checking=true;this.lastCheck=Date.now();
    try {
      if(process.platform!=='win32')throw new Error('Battery telemetry is available on Windows');
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const result=await runProcess(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; @(Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus) | ConvertTo-Json -Compress"],{timeoutMs:8000});
      if(result.code!==0)throw new Error('Windows 电池状态不可用');
      this.value=parseBattery(result.stdout.trim());
    }catch {this.value={present:null,percent:null,charging:null,message:'电量暂不可用'};}
    finally {this.checking=false;}
  }
}

export class UsageMeter {
  private value={inputTokens:0,outputTokens:0,totalTokens:0,calls:0,estimated:false,lastInputTokens:0,lastOutputTokens:0};
  add(usage: ModelUsage) {
    this.value.inputTokens += usage.inputTokens; this.value.outputTokens += usage.outputTokens;
    this.value.totalTokens = this.value.inputTokens + this.value.outputTokens; this.value.calls++;
    this.value.estimated ||= usage.estimated;
    this.value.lastInputTokens=usage.inputTokens;this.value.lastOutputTokens=usage.outputTokens;
  }
  snapshot(contextWindowTokens=32768) {
    return {...this.value,contextWindowTokens,contextPercent: Math.min(100,100 * this.value.lastInputTokens/contextWindowTokens)};
  }
}
export class SystemMonitor {
  private previous=os.cpus();
  read() {
    const cpus=os.cpus();
    const cores=cpus.map((cpu,i)=>{
      const old=this.previous[i]?.times;if(!old)return 0;
      const total=Object.values(cpu.times).reduce((a,b)=>a+b,0)-Object.values(old).reduce((a,b)=>a+b,0);
      return total>0?Math.max(0,Math.min(100,100*(1-(cpu.times.idle-old.idle)/total))):0;
    });
    this.previous=cpus;
    const totalBytes=os.totalmem(),usedBytes=totalBytes-os.freemem();
    return {timestamp:new Date().toISOString(),cpu:{percent:cores.length?cores.reduce((a,b)=>a+b,0)/cores.length:0,cores},memory:{usedBytes,totalBytes,percent:100*usedBytes/totalBytes}};
  }
}

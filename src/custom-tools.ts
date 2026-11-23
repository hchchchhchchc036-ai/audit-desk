import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {runProcess, safeEnvironment} from './ocr';
import {redact} from './model';
import {replaceFile} from './file-replace';
import {runLocal} from './local-runner';
import type {ModelSettings,ProjectSnapshot} from './contracts';

export type CustomTool={id:string;name:string;description:string;command:string[];image?:string;enabled:boolean;updatedAt:string};
export type ToolResult={toolName:string;exitCode:number;stdout:string;stderr:string;durationMs:number;reportDir:string;projectId:string};
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
function argv(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length||value.length>80||value.some(v=>typeof v!=='string'||v.length>8000||v.includes('\0'))||!value[0].trim())throw new Error('工具命令必须是非空 argv 字符串数组');
  return [...value];
}
function imageValid(image:string){if(!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/.test(image))throw new Error('工具镜像名称无效');}
export class CustomToolRegistry{
  private pending:Promise<unknown>=Promise.resolve();
  private running=false;
  private activeController?:AbortController;
  private finished:Promise<void>=Promise.resolve();
  private finish?:()=>void;
  constructor(private root:string){}
  private mutate<T>(fn:()=>Promise<T>):Promise<T>{const job=this.pending.then(fn);this.pending=job.catch(()=>{});return job;}
  async init(){await fs.mkdir(this.root,{recursive:true});}
  async list():Promise<CustomTool[]>{
    try{
      const file=path.join(this.root,'tools.json'),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('工具注册文件无效');
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      if(!Array.isArray(data)||data.length>100||data.some((t:any)=>!validId(t.id)))throw new Error('工具注册表无效');
      return data;
    }catch(e:any){if(e.code==='ENOENT')return [];throw e;}
  }
  private async write(tools:CustomTool[]){const temp=path.join(this.root,'tools.tmp');await fs.writeFile(temp,JSON.stringify(tools,null,2),{mode:0o600});await replaceFile(temp,path.join(this.root,'tools.json'));}
  async save(input:any):Promise<CustomTool>{return this.mutate(async()=>{
    if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.description!=='string'||input.description.length>2000)throw new Error('请填写工具名称和审计／测试用途');
    const command=argv(input.command);if(input.image)imageValid(input.image);
    const tools=await this.list();
    if(input.id&&!validId(input.id))throw new Error('工具 ID 无效');
    if(input.id&&!tools.some(t=>t.id===input.id))throw new Error('工具不存在');
    if(!input.id&&tools.length>=100)throw new Error('最多注册 100 个工具');
    const tool:CustomTool={id:input.id||randomUUID(),name:input.name.trim(),description:input.description,command,image:input.image||undefined,enabled:input.enabled===true,updatedAt:new Date().toISOString()};
    await this.write([...tools.filter(t=>t.id!==tool.id),tool]);return tool;
  });}
  async setEnabled(id:string,enabled:boolean){return this.mutate(async()=>{if(!validId(id)||typeof enabled!=='boolean')throw new Error('工具状态无效');const tools=await this.list(),tool=tools.find(t=>t.id===id);if(!tool)throw new Error('工具不存在');tool.enabled=enabled;await this.write(tools);});}
  async remove(id:string){return this.mutate(async()=>{if(!validId(id))throw new Error('工具 ID 无效');await this.write((await this.list()).filter(t=>t.id!==id));});}
  async getEnabled(ids:string[]):Promise<CustomTool[]>{
    if(!Array.isArray(ids)||ids.length>10||ids.some(id=>!validId(id)))throw new Error('最多选择 10 个已注册工具');
    const all=await this.list();return [...new Set(ids)].map(id=>{const t=all.find(t=>t.id===id);if(!t?.enabled)throw new Error('工具不存在或未启用：'+id);return {...t,command:argv(t.command)};});
  }
  async shutdown(){this.activeController?.abort();await this.finished;}
  async run(id:string,project:ProjectSnapshot,args:string[],settings:ModelSettings,signal?:AbortSignal):Promise<ToolResult>{
    const [tool]=await this.getEnabled([id]);
    if(!Array.isArray(args)||args.length>40||args.some(a=>typeof a!=='string'||a.length>8000||a.includes('\0')))throw new Error('工具参数必须是字符串数组');
    // ponytail: one local tool at a time; replace with a bounded queue if throughput matters.
    if(this.running)throw new Error('已有自定义工具正在运行，请等待其结束');
    const local=settings.testExecution!=='docker';
    const image=tool.image||settings.containerImage;if(!local)imageValid(image);
    this.running=true;
    this.activeController=new AbortController();
    signal=signal?AbortSignal.any([signal,this.activeController.signal]):this.activeController.signal;
    this.finished=new Promise(resolve=>{this.finish=resolve;});
    const name='auditdesk-tool-'+randomUUID();
    const reportDir=path.join(this.root,'runs',randomUUID()),staged=path.join(reportDir,'source');
    const env={...safeEnvironment(),HOME:reportDir,USERPROFILE:reportDir,TEMP:reportDir,TMP:reportDir,DOCKER_CONFIG:path.join(this.root,'docker-config')};
    let launched=false;const started=Date.now();
    try{
      await fs.mkdir(staged,{recursive:true});await fs.mkdir(env.DOCKER_CONFIG,{recursive:true});
      if(!local){const inspect=await runProcess('docker',['image','inspect',image],{env,signal,timeoutMs:10000});
      if(inspect.code!==0)throw new Error(`本地缺少工具镜像 ${image}；先准备含运行器的可信镜像`);}
      let bytes=0;
      for(const file of project.files){
        if(file.status!=='read'||file.content===undefined)continue;
        if(path.isAbsolute(file.path)||file.path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||/[:\0]/.test(file.path))throw new Error('项目快照含无效文件路径');
        bytes+=Buffer.byteLength(file.content);if(bytes>40*1024*1024)throw new Error('工具源码副本超过 40MB');
        const target=path.join(staged,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content,{flag:'wx'});
      }
      launched=!local;
      const processResult=local ? await runLocal([...tool.command,...args],staged,signal,Math.min(settings.timeoutSeconds,300)*1000,settings.apiKey) : await runProcess('docker',['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=1','--memory=512m','--memory-swap=512m','--pids-limit=64','--ulimit','nofile=256:256','--ulimit','fsize=65536:65536','--user','65534:65534','--tmpfs','/work:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777','--mount',`type=bind,source=${staged},target=/source,readonly`,'--workdir','/work','--entrypoint','/bin/sh',image,'-c','cp -R /source/. /work/ && exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work TMPDIR=/tmp "$@"','auditdesk',...tool.command,...args],{env,signal,timeoutMs:Math.min(settings.timeoutSeconds,300)*1000,secret:settings.apiKey});
      const result:ToolResult={toolName:tool.name,projectId:project.id,exitCode:processResult.code,stdout:redact(processResult.stdout,settings.apiKey).slice(0,128000),stderr:redact(processResult.stderr,settings.apiKey).slice(0,32000),durationMs:Date.now()-started,reportDir};
      await fs.writeFile(path.join(reportDir,'tool-result.json'),JSON.stringify({...result,command:[...tool.command,...args].map(a=>redact(a,settings.apiKey)),executionMode:local?'local':'docker',image:local?undefined:image},null,2));return result;
    }finally{
      if(launched)await runProcess('docker',['rm','-f',name],{env,timeoutMs:10000}).catch(()=>{});
      this.running=false;
      this.activeController=undefined;this.finish?.();this.finish=undefined;
    }
  }
}

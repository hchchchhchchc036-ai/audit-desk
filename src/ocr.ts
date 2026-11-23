import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ModelSettings } from './contracts';
import { redact } from './model';
import { replaceFile } from './file-replace';

export type ProcessResult = { code: number; stdout: string; stderr: string };
async function withCancellation<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve,reject)=>{
    const aborted=()=>reject(new Error('任务已取消'));
    signal.addEventListener('abort',aborted,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}
export function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function ocrEnvironment(s: ModelSettings, home: string): NodeJS.ProcessEnv {
  let base = s.baseUrl.replace(/\/(chat\/completions|messages)\/?$/, '').replace(/\/$/, '');
  if (s.protocol === 'anthropic') base = base.replace(/\/v1$/, '');
  return { ...safeEnvironment(), HOME: home, USERPROFILE: home, TMP: home, TEMP: home,
    OCR_LLM_URL: base, OCR_LLM_TOKEN: s.apiKey || 'local-no-key', OCR_LLM_MODEL: s.model,
    OCR_LLM_PROTOCOL: s.protocol, OCR_USE_ANTHROPIC: String(s.protocol === 'anthropic'),
    ...(s.protocol === 'anthropic' ? {OCR_LLM_AUTH_HEADER:'x-api-key'} : {}),
    OCR_LLM_TIMEOUT: String(s.timeoutSeconds), TERM: 'dumb', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0'
  };
}
export async function runProcess(binary: string, args: string[], options: {cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; onLog?: (line: string) => void; secret?: string} = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env || safeEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let size = 0; let forced: string | undefined;
    const stop = (reason: string) => {
      if (forced) return;
      forced = reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const onAbort = () => stop('任务已取消');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('进程超时，已终止进程树'), options.timeoutMs || 120000);
    const pending = { out: '', err: '' };
    const consume = (chunk: Buffer, error: boolean) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { stop('进程输出超过 12MB 上限'); return; }
      const value = chunk.toString('utf8');
      if (error) stderr += value; else stdout += value;
      const stream = error ? 'err' : 'out'; pending[stream] += value;
      const lines = pending[stream].split(/\r?\n/); pending[stream] = lines.pop() || '';
      if (pending[stream].length > 1048576) { stop('单行进程输出超过 1MB 上限'); return; }
      if (options.onLog) for (const line of lines.filter(Boolean)) options.onLog(redact(line, options.secret).slice(0, 2000));
    };
    child.stdout.on('data', b => consume(b, false));
    child.stderr.on('data', b => consume(b, true));
    child.once('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      for (const tail of Object.values(pending)) if (tail && options.onLog) options.onLog(redact(tail, options.secret).slice(0,2000));
      if (forced) reject(new Error(forced)); else resolve({ code: code ?? -1, stdout: redact(stdout,options.secret), stderr:redact(stderr,options.secret) });
    });
  });
}

export class OcrManager {
  private installing?: Promise<{available: boolean; path?: string; message: string}>;
  constructor(private root: string, private settings: () => ModelSettings) {}
  async detect(): Promise<{available: boolean; path?: string; message: string}> {
    const candidates = [this.settings().ocrPath, path.join(this.root, 'bin', 'ocr.exe'),
      path.join(os.homedir(), '.local', 'bin', 'ocr.exe'), path.join(os.homedir(), '.local', 'bin', 'opencodereview.exe')];
    for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'ocr.exe' : 'ocr'));
    for (const candidate of candidates.filter(Boolean) as string[]) {
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        const check = await runProcess(candidate, ['scan', '--help'], { timeoutMs: 10000 });
        if (check.code === 0 && check.stdout.includes('--output') && check.stdout.includes('--repo'))
          return { available: true, path: candidate, message: '已就绪；使用软件中的同一模型，无需额外配置' };
      } catch { /* Try next explicit binary. */ }
    }
    return { available: false, message: '未检测到支持全文件扫描的 OCR；首次审计时自动下载，也可点击安装' };
  }
  async install() {
    if (this.installing) return this.installing;
    this.installing = this.download().finally(() => { this.installing = undefined; });
    return this.installing;
  }
  private async download() {
    const current = await this.detect();
    if (current.available) return current;
    if (process.platform !== 'win32') throw new Error('此安装器面向 Windows；请手动设置本平台 OCR 可执行文件');
    const releaseResponse = await fetch('https://api.github.com/repos/alibaba/open-code-review/releases/latest', { headers: { 'User-Agent': 'Audit-Desk' }, signal: AbortSignal.timeout(30000) });
    if (!releaseResponse.ok) throw new Error(`GitHub 发布信息下载失败 HTTP ${releaseResponse.status}；检查网络后重试安装`);
    const release: any = await releaseResponse.json();
    const asset = release.assets?.find((x: any) => x.name === `opencodereview-windows-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.exe`);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || asset.size > 120 * 1024 * 1024) throw new Error('官方发行文件缺少 SHA256 或大小不符合要求，已停止安装');
    const allowed = `https://github.com/alibaba/open-code-review/releases/download/${release.tag_name}/`;
    if (!asset.browser_download_url.startsWith(allowed)) throw new Error('OCR 下载地址不属于官方发行仓库');
    await fs.mkdir(path.join(this.root, 'bin'), { recursive: true });
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`OCR 下载失败 HTTP ${response.status}`);
    const temporary = path.join(this.root, 'bin', 'ocr.download');
    const file = await fs.open(temporary, 'w', 0o600);
    let size = 0; const hash = createHash('sha256');
    try {
      for await (const chunk of response.body as any) {
        size += chunk.length;
        if (size > asset.size || size > 120 * 1024 * 1024) throw new Error('OCR 下载超过大小上限');
        hash.update(chunk); await file.write(chunk);
      }
    } finally { await file.close(); }
    if (size !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) { await fs.unlink(temporary); throw new Error('OCR 官方文件 SHA256 校验失败，未安装'); }
    const target = path.join(this.root, 'bin', 'ocr.exe');
    await replaceFile(temporary, target);
    await fs.writeFile(path.join(this.root, 'bin', 'ocr-source.json'), JSON.stringify({ repo: 'alibaba/open-code-review', tag: release.tag_name, digest: asset.digest, installedAt: new Date().toISOString() }, null, 2));
    return this.detect();
  }
  async run(args: string[], cwd: string, signal: AbortSignal, onLog: (line: string) => void): Promise<ProcessResult> {
    let executable = await withCancellation(this.detect(),signal);
    if (!executable.available) { onLog('首次使用：正在下载官方 OCR 并校验 SHA256…'); executable = await withCancellation(this.install(),signal); }
    signal.throwIfAborted();
    if (!executable.available || !executable.path) throw new Error(executable.message);
    const settings = this.settings();
    if (!settings.model) throw new Error('请先在软件中配置模型；OCR 将直接使用这套配置');
    const home = await fs.mkdtemp(path.join(this.root, 'ocr-session-'));
    try {
      await fs.writeFile(path.join(home, 'empty-gitconfig'), '');
      const env=ocrEnvironment(settings,home);
      const extraBody={max_tokens:settings.maxOutputTokens,...(settings.protocol==='openai'&&new URL(settings.baseUrl).hostname==='api.deepseek.com'&&settings.thinkingMode!=='auto'?{thinking:{type:settings.thinkingMode||'disabled'}}:{})};
      for(const [key,value] of [['language','Chinese'],['llm.extra_body',JSON.stringify(extraBody)]]){
        const configured=await runProcess(executable.path,['config','set',key,value],{cwd:home,env,signal,timeoutMs:10000,secret:settings.apiKey});
        if(configured.code!==0)throw new Error('同步 OCR 模型配置失败：'+key+'；'+configured.stderr.slice(0,500));
      }
      const options = [...args,...(args.includes('--max-tokens-budget')?[]:['--max-tokens-budget',String(settings.tokenBudget)]),...(args.includes('--concurrency')?[]:['--concurrency',String(settings.concurrency)])];
      onLog(`OCR 使用统一模型：${settings.model}；地址 ${settings.baseUrl}`);
      return await runProcess(executable.path, options, {cwd, env: ocrEnvironment(settings, home), signal, timeoutMs: Math.min(3600000, settings.timeoutSeconds * 1000 * 10), onLog, secret: settings.apiKey});
    } finally {
      // Only remove this app-created scratch directory after the child process exits.
      const relative = path.relative(this.root, home);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await fs.rm(home, { recursive: true, force: true });
    }
  }
}

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runProcess, safeEnvironment } from './ocr';

export async function browserRuntime(){
  const moduleRoot=path.dirname(path.dirname(require.resolve('playwright/package.json')));
  const paths=process.platform==='win32'?[path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.ProgramFiles||'C:/Program Files','Microsoft/Edge/Application/msedge.exe'),path.join(process.env.ProgramFiles||'C:/Program Files','Google/Chrome/Application/chrome.exe')]:[];
  let executablePath:string|undefined;
  for(const candidate of paths)if(await fs.stat(candidate).then(stat=>stat.isFile(),()=>false)){executablePath=candidate;break;}
  return {moduleRoot,executablePath};
}

export async function runLocal(command: string[], cwd: string, signal: AbortSignal, timeoutMs: number, secret?: string) {
  let [binary, ...args] = command;
  const browser=await browserRuntime();
  if(/^(?:node(?:\.exe)?|npm(?:\.cmd)?)$/i.test(binary)){
    const shim=path.join(cwd,'node_modules','playwright');await fs.mkdir(shim,{recursive:true});
    await fs.writeFile(path.join(shim,'package.json'),JSON.stringify({name:'playwright',main:'index.cjs'}),{flag:'wx'});
    await fs.writeFile(path.join(shim,'index.cjs'),`const runtime=require(${JSON.stringify(path.join(browser.moduleRoot,'playwright'))});\nmodule.exports=runtime;\n`+['chromium','firefox','webkit','request','devices','selectors','errors'].map(name=>`module.exports.${name}=runtime.${name};`).join('\n'),{flag:'wx'});
  }
  const env = { ...safeEnvironment(), HOME: cwd, USERPROFILE: cwd, TMP: cwd, TEMP: cwd, ELECTRON_RUN_AS_NODE: '1', PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',NODE_PATH:browser.moduleRoot,...(browser.executablePath?{AUDIT_DESK_BROWSER:browser.executablePath}:{}) };
  // Use Electron's embedded Node runtime; no separate Node install is needed.
  if (/^node(?:\.exe)?$/i.test(binary)) {
    binary = process.execPath;
    if (args.includes('--test') && !args.some(arg => arg.startsWith('--test-reporter'))) args = ['--test-reporter=tap', ...args];
  }
  else if (/^npm(?:\.cmd)?$/i.test(binary)) {
    const candidates = (process.env.PATH || process.env.Path || '').split(path.delimiter).map(dir => path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    let cli: string | undefined;
    for (const candidate of candidates) { if (await fs.stat(candidate).then(s => s.isFile(), () => false)) { cli = candidate; break; } }
    if (!cli) throw new Error('本机未找到 npm；请安装 Node.js，或使用 node 运行不依赖 npm 的测试');
    binary = process.execPath; args = [cli, ...args];
  } else if (/\.(cmd|bat)$/i.test(binary)) throw new Error('本地模式不直接运行 cmd/bat；请指定 node、python 等运行器和独立参数');
  return runProcess(binary, args, { cwd, env, signal, timeoutMs, secret });
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectSnapshot, TaskRecord } from './contracts';
import {buildChineseReport,reportStatus,reportTitle} from './report-content';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export async function writeHumanReport(task:TaskRecord):Promise<void>{
  await mkdir(task.reportDir,{recursive:true});
  const markdown = `# ${reportTitle(task)}\n\n` + buildChineseReport(task).map(section => `## ${section.title}\n\n${(section.lines||[]).join('\n\n')}\n\n${section.table ? ['| '+section.table.headers.join(' | ')+' |','| '+section.table.headers.map(()=> '---').join(' | ')+' |',...section.table.rows.map(row=>'| '+row.map(cell=>String(cell).replace(/\|/g,'\\|').replace(/\n/g,' ')).join(' | ')+' |')].join('\n')+'\n\n' : ''}${section.code ? section.code.split('\n').map(line=>'    '+line).join('\n')+'\n' : ''}`).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(reportTitle(task))}</title><style>:root{color-scheme:dark}body{background:#0a0a0a;color:#c2d7bb;font:15px/1.7 Consolas,'Microsoft YaHei',monospace;max-width:1050px;margin:36px auto;padding:20px}h1,h2{color:#33ff00}h1{border-bottom:1px solid #1f521f;padding-bottom:14px}h2{font-size:19px;margin-top:32px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,monospace;border:1px solid #1f521f;padding:14px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #1f521f;padding:9px 12px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{color:#33ff00;background:#102010}.status{color:#ffb000}p{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(reportTitle(task))}</h1><p class="status">状态：${escapeHtml(reportStatus[task.status]||task.status)}</p>${buildChineseReport(task).map(section=>`<section><h2>${escapeHtml(section.title)}</h2>${(section.lines||[]).map(line=>`<p>${escapeHtml(line)}</p>`).join('')}${section.table?`<table><thead><tr>${section.table.headers.map(cell=>`<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${section.table.rows.map(row=>`<tr>${row.map(cell=>`<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:''}${section.code?`<pre>${escapeHtml(section.code)}</pre>`:''}</section>`).join('')}</body></html>`;
  await Promise.all([writeFile(path.join(task.reportDir,'report.md'),markdown,'utf8'),writeFile(path.join(task.reportDir,'report.html'),html,'utf8')]);
  if(task.kind==='audit'&&task.metrics?.structuredFindings){
    const state=['running','queued'].includes(task.status)?'in_progress':task.metrics.companionSchemaValidated&&!(task.metrics.workflowGaps as unknown[]|undefined)?.length&&!['cancelled','blocked'].includes(task.status)?'complete':'incomplete';
    const pending=task.findings.filter(f=>['candidate','needs_validation'].includes(f.status));
    await Promise.all([
      writeFile(path.join(task.reportDir,'SECURITY-REPORT.md'),`# 安全审计报告\n\n<!-- Run status: ${state} -->\n\n`+markdown,'utf8'),
      writeFile(path.join(task.reportDir,'FINDINGS-DETAIL.md'),task.findings.length?'# 问题详情\n\n'+markdown:'# 问题详情\n\n本次没有保留的问题记录；是否完成审计请参阅主报告。','utf8'),
      writeFile(path.join(task.reportDir,'NEEDS-VALIDATION.md'),'# 待验证问题\n\n'+(pending.length?pending.map(f=>`## ${f.title}\n\n位置：${f.path}:${f.line}\n\n原因与验证：${f.rootCause||f.detail}\n\n修改建议：${f.recommendation}`).join('\n\n'):'当前没有待验证的问题记录；这不代表未审查范围也正常。'),'utf8'),
      writeFile(path.join(task.reportDir,'architecture.md'),'# 项目架构与侦察记录\n\n项目：'+task.projectName+'\n\n架构流程图见同目录 `project.mmd`；审计运行流程图见 `task-flow.mmd`。\n\n以下为侦察阶段的原始结构化记录，字段与代码标识保留原文：\n\n```json\n'+JSON.stringify(((task.metrics.jobs||[]) as any[]).filter(j=>j.phase?.startsWith('recon-')),null,2).slice(0,10000)+'\n```','utf8')
    ]);
  }
}

export async function writeReport(task: TaskRecord, project?: ProjectSnapshot): Promise<void> {
  await mkdir(task.reportDir, { recursive: true });
  const snapshot = project ? { id: project.id, name: project.name, indexedAt: project.indexedAt, files: project.files.map(({ content, ...file }) => file), warnings: project.warnings } : undefined;
  const report = { ...task, project: snapshot };
  await Promise.all([
    writeFile(path.join(task.reportDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8'),
    writeHumanReport(task),
    writeFile(path.join(task.reportDir, 'task-flow.mmd'), task.diagram || 'flowchart LR\n  Queue --> Execute --> Evidence --> Report\n', 'utf8'),
    writeFile(path.join(task.reportDir, 'project.mmd'), project?.diagram || 'flowchart LR\n  Project[Project snapshot unavailable]\n', 'utf8')
  ]);
}

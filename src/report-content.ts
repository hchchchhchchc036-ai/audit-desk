import type {Finding, TaskRecord} from './contracts';

export type ReportSection = {title:string;lines?:string[];table?:{headers:string[];rows:string[][]};code?:string};
export const reportStatus:Record<string,string>={queued:'排队中',running:'执行中',passed:'正常',failed:'发现问题',partial:'部分完成，待验证',cancelled:'已取消',blocked:'未执行',confirmed:'已确认',needs_validation:'待验证',rejected:'已排除',candidate:'候选问题'};
const testType:Record<string,string>={unit:'单元测试',functional:'功能测试',automation:'自动化测试',performance:'性能测试'};
const severity:Record<string,string>={critical:'严重',high:'高',medium:'中',low:'低',info:'提示',informational:'提示'};
const text=(value:unknown,limit=12000)=>String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'').slice(0,limit);
const chinese=(value:unknown,fallback:string)=>typeof value==='string'&&/[\u3400-\u9fff]/.test(value)?text(value):fallback;
const phaseNames:Record<string,string>={prepare:'准备环境',modelgen:'生成测试',docker:'Docker 执行',local:'本地执行',evidence:'采集证据',report:'生成报告',index:'索引范围',recon:'项目侦察',discovery:'发现问题',verification:'验证问题',schema:'结构校验','custom-tools':'自定义工具'};

export function reportTitle(task:TaskRecord):string{return `${task.projectName} · ${task.kind==='test'?(testType[task.input.testType||'unit']||'软件测试'):'代码审计'}报告`;}
export function reportSummary(task:TaskRecord):string {
  if(task.kind==='test'){
    if(task.status==='passed')return '正常：已完成本次测试，运行器记录的测试通过，未发现本次测试范围内的异常。此结论不代表未测试功能也正常。';
    if(task.status==='failed')return '发现问题：测试执行失败、存在失败断言或性能阈值不达标，详见下方实际结果和错误证据。';
  }else if(task.status==='passed')return '本次已完成的审计范围内未发现已确认问题；不等于软件不存在其他缺陷。';
  else if(task.status==='failed')return task.findings.some(f=>f.status==='confirmed')?'发现已确认的审计问题，详见下方问题位置、依赖与问题链及修改建议。':'审计执行器失败，尚不能给出完整审计结论；执行失败不等于确认软件存在漏洞。';
  const state=reportStatus[task.status]||'状态未知';
  return `${state}：本次尚不能给出完整正常结论。${chinese(task.summary,'请查看任务状态、覆盖缺口及原始执行日志；未完成项目需继续验证。')}`;
}

function findingSections(f:Finding,index:number,task:TaskRecord):ReportSection[]{
  const canonical=(Array.isArray(task.metrics?.structuredFindings)?task.metrics.structuredFindings as any[]:[]).find(r=>r.title===f.title&&r.evidence?.some((e:any)=>e.file===f.path&&e.line===f.line));
  const steps=f.trace?.length?f.trace:(Array.isArray(canonical?.trace)?canonical.trace:[]);
  const exactChain=steps.length>1&&steps[0].kind==='entrypoint'&&steps.at(-1)?.kind==='sink';
  const chainState=f.status==='confirmed'&&exactChain?'已确认的源码问题链':'待验证的关联路径，不作为完整利用链结论';
  const chain=steps.length?steps.map((step:any,n:number)=>`${n+1}. ${({'entrypoint':'输入入口','propagation':'中间传播','sink':'关键操作'} as any)[step.kind]||'关联位置'}：${step.file}:${step.line}${step.scope?'（'+step.scope+'）':''}；${chinese(step.description,'源码关联位置，需结合原始引用验证逻辑。')}`):['未获得完整的入口、传播过程和关键操作证据，不能确认存在“一环套一环”的问题链。'];
  const dependencies=f.dependencies||[];
  return [{title:`问题 ${index+1}：${chinese(f.title,'源码审查发现的候选问题')}`,lines:[
    `问题状态：${reportStatus[f.status]||f.status}${f.severity?'；风险等级：'+(severity[f.severity]||f.severity):''}`,
    `问题位置：${f.path}:${f.line}`,
    `问题原因${f.status==='confirmed'?'（已验证）':'（待验证假设）'}：${chinese(f.rootCause||canonical?.root_cause||canonical?.claimed_root_cause||f.detail,'具体原因尚未形成中文、可复核的结论；原始记录保留在后附证据中。')}`,
    `验证结论：${chinese(f.detail,'需要结合源码证据进一步验证。')}`,
    `可能影响：${chinese(f.impact||canonical?.execution?.observed_result,'影响范围尚未充分证明，不推定生产环境可利用。')}`,
    `修改建议：${chinese(f.recommendation||canonical?.remediation?.strategy,'先核对标注位置的输入校验和权限边界，再按实际根因修改并补充回归测试；当前缺少针对性修复证据。')}`,
    `复测方法：${chinese(f.validationPlan||canonical?.validation_plan?.local,'使用正常输入和触发问题的边界输入复测，检查预期结果、权限限制和其他调用方是否受影响。')}`
  ]}, {title:`问题 ${index+1}：依赖与问题链`,lines:[
    ...dependencies.map(d=>`${d.kind==='package'?'第三方依赖':'内部模块'}：${d.name}${d.version?'；声明或锁定版本：'+d.version:''}；证据位置：${d.file}:${d.line}；${chinese(d.relationship,'源码中存在关联引用，是否为问题根因仍需独立验证。')}`),
    ...(dependencies.length?['上述依赖有源码引用证据；仅存在依赖不代表该依赖有漏洞，版本是否受影响需有对应依据。']:['未取得直接依赖证据，不能把问题归因于某个第三方库或其版本。']),
    `链条状态：${chainState}`,...chain,
    `链条分析：${chinese(f.chainAnalysis,exactChain?'已列出入口至关键操作的关联位置，链条是否成立以问题状态和独立验证结论为准。':'尚未证明完整因果链，不能确认多个问题能串联利用。')}`
  ]},{title:`问题 ${index+1}：源码证据`,code:f.evidence||'未提供可直接核对的源码片段。'},
  ...(!/[\u3400-\u9fff]/.test(f.title+f.detail+f.recommendation)?[{title:`问题 ${index+1}：历史原始记录`,lines:['此历史记录由旧版模型以外文生成，保留原文供复核；重新运行审计会要求模型输出中文。'],code:[f.title,f.rootCause||f.detail,f.recommendation].filter(Boolean).join('\n')}]:[])];
}

export function buildChineseReport(task:TaskRecord):ReportSection[]{
  const m=task.metrics||{},usage=m.usage as any,sections:ReportSection[]=[];
  if(m.checkpoint){const checkpoint=m.checkpoint as any;sections.push({title:'续审与用量来源',lines:[`本次续审来源：${checkpoint.taskId}。原取消报告保持不变。`,`通过源码哈希、Skill、目标、模型及项目上下文校验后，复用 ${checkpoint.reusedPhases?.length||0} 个已完成阶段；最终覆盖复核与候选验证重新调用模型。`,`此前累计使用 ${checkpoint.inheritedUsageTokens||0} Token；本报告用量统计仅列本次新增调用。任务预算仍扣除此前累计用量。`]});}
  sections.push({title:'一、任务结论',lines:[reportSummary(task)],table:{headers:['项目','实际记录'],rows:[['项目名称',task.projectName],['任务类型',task.kind==='test'?(testType[task.input.testType||'unit']||'软件测试'):'代码审计'],['任务状态',reportStatus[task.status]||task.status],['开始时间',task.createdAt],['结束时间',task.finishedAt||'尚未结束'],['选择范围',task.input.scopes.join('、')||'未提供'],['执行方式',m.executionMode==='local'?'本地项目副本':m.executionMode==='docker'?'Docker 隔离环境':task.input.engine==='ocr'?'Open Code Review':'源码静态审计'],['模型 Token',usage?`输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} / 合计 ${usage.totalTokens}${usage.estimated?'（估算）':'（接口报告）'}`:task.kind==='test'&&!task.input.generate&&!task.input.toolIds?.length?'本次测试未调用模型，Token 为 0':'执行器未报告模型用量']]}});
  if(task.kind==='test'){
    const cases=Array.isArray(m.testCases)?m.testCases as any[]:[];
    const command=Array.isArray(m.command)?m.command:task.input.command;
    sections.push({title:'二、测试了什么',lines:[`测试类型：${testType[task.input.testType||'unit']||'软件测试'}`,`测试目标：${chinese(task.input.objective?.split('\n\n本项目已有工作记忆')[0],'用户未填写具体业务验收目标；结论仅覆盖实际执行的用例。')}`,`测试计划：${chinese(m.generatedPlan,task.input.generate?'使用模型生成测试计划与用例，实际执行内容见命令和用例结果。':'复用已有测试命令或已发现的测试文件。')}`,`实际命令：${command?JSON.stringify(command):'没有实际执行命令'}`,`通过数：${Number(m.passed)||0}；失败数：${Number(m.failed)||0}；退出码：${m.exitCode??'未执行或未报告'}`,`执行耗时：${typeof m.elapsedMs==='number'?(m.elapsedMs/1000).toFixed(2)+' 秒':'未报告'}`],table:cases.length?{headers:['实际用例（名称保留运行器原文）','结果'],rows:cases.map(c=>[text(c.name,1000),c.status==='passed'?'正常':c.status==='failed'?'有问题':c.status==='skipped'?'已跳过，未验证':'未完成'])}:{headers:['检查项目','结果'],rows:[[testType[task.input.testType||'unit']||'测试任务',task.status==='passed'?'正常':reportStatus[task.status]||'未验证']]}});
    const perf=m.metrics as any;
    if(Array.isArray(m.testAttempts))sections.push({title:'实际执行轮次与测试脚本修正',lines:[m.testAttempts.length>1?'保留了首次失败和后续每轮实际执行结果。自动修正仅作用于测试脚本，不代表生产源码被模型自动修复；最后通过也不会抹去首次失败记录。':'本次仅执行一轮，以下为真实运行记录。'],table:{headers:['轮次','结果','通过 / 失败','日志'],rows:(m.testAttempts as any[]).map(item=>[String(item.attempt),reportStatus[item.status]||item.status,`${item.passed} / ${item.failed}`,String(item.log)])}});
    if(Array.isArray(m.testRepairs))for(const repair of m.testRepairs as any[])sections.push({title:`第 ${repair.attempt} 轮测试脚本修正依据`,lines:(repair.changes||[]).flatMap((change:any)=>[chinese(change.reason,'测试运行器修正，原始依据见 JSON'),...(change.evidence||[]).map((e:any)=>`${e.file}:${e.line} — ${text(e.excerpt,1500)}`)])});
    if(task.input.testType==='performance')sections.push({title:'性能实测指标',table:{headers:['指标','实测值'],rows:[['请求数',perf?.requests],['并发数',perf?.concurrency],['持续时间（秒）',perf?.durationSeconds],['吞吐量（次/秒）',perf?.throughputPerSecond],['错误率',perf?.errorRate],['P50（毫秒）',perf?.p50Ms],['P95（毫秒）',perf?.p95Ms],['P99（毫秒）',perf?.p99Ms],['设定延迟阈值（毫秒）',task.input.thresholdMs]].map(([name,value])=>[String(name),value===undefined?'未报告':String(value)])}});
    sections.push({title:'三、测试发现的问题',lines:[task.status==='passed'?'正常：本次实际执行的用例未报告失败。':task.status==='failed'?'有问题：根据失败断言、进程退出码和性能指标定位；具体错误见下方原始执行证据。':'本次测试尚未完成，不能判定正常。',...(task.status==='passed'?[]:[chinese(task.summary,'具体错误信息已保留在附录日志，请结合失败用例和退出码定位。')]),...(Array.isArray(m.artifacts)?(m.artifacts as any[]).map(a=>'证据文件：'+text(a.path)):[])]});
    for(const item of cases.filter(c=>c.status==='failed'))sections.push({title:'失败用例：'+text(item.name,1000),lines:[`问题位置：${item.location?text(item.location):'运行器未提供精确源码行号'}`,`问题原因：${chinese(item.cause,'用例运行失败，具体业务根因待验证。')}`,...(item.expected!==undefined?['预期结果：'+text(item.expected,2000)]:[]),...(item.actual!==undefined?['实际结果：'+text(item.actual,2000)]:[]),'改动建议：核对该用例覆盖的实现、输入与业务预期，再修复实现并回归相关调用方；不要只删掉失败断言。']});
    if(task.input.testType==='performance'&&typeof perf?.p95Ms==='number'&&task.input.thresholdMs!==undefined&&perf.p95Ms>task.input.thresholdMs)sections.push({title:'性能问题原因',lines:[`P95 实测 ${perf.p95Ms} 毫秒，高于设定阈值 ${task.input.thresholdMs} 毫秒。`,'在相同并发与持续时间下定位耗时操作，修改后按相同负载复测。']});
    if(task.input.testType==='performance'&&typeof perf?.errorRate==='number'&&perf.errorRate>0)sections.push({title:'性能请求错误',lines:[`实测请求错误率 ${(perf.errorRate*100).toFixed(2)}%，存在未成功完成的请求。`,'先核对失败请求的响应码、异常与超时，再按相同负载复测；不能仅凭延迟达标判为正常。']});
    if(task.status!=='passed')sections.push({title:'修改与复测建议',lines:['先处理日志中最早的失败断言或异常位置，确认实际输入与预期结果。','如缺少运行器或依赖，先准备对应测试环境；本报告不将环境未就绪视为业务缺陷。','修改后重新执行同一测试，并补测相关调用方和边界输入；性能问题须按相同负载复测。']});
  }else{
    sections.push({title:'二、审计覆盖与问题概览',lines:[`已审查文件：${task.coverage.reviewed} / ${task.coverage.total}；跳过：${task.coverage.skipped}`,`已确认问题：${task.findings.filter(f=>f.status==='confirmed').length}；待验证或候选：${task.findings.filter(f=>['needs_validation','candidate'].includes(f.status)).length}；已排除：${task.findings.filter(f=>f.status==='rejected').length}`,task.findings.length?'以下逐项列出位置、原因、依赖关系和修改建议。':task.status==='passed'?'本次完整审查范围内未发现已确认问题。':'当前没有已确认的问题记录，但审计尚未完成，不能写成正常。']});
    task.findings.forEach((f,i)=>sections.push(...findingSections(f,i,task)));
    if(Array.isArray(m.sourceExclusions)&&m.sourceExclusions.length)sections.push({title:'源码审计范围的明确排除项',lines:['下列资源不属于本次可读源码审查范围，其内容未经过安全验证。读取失败或超过预算的源码仍属于未完成检查，不会通过此清单冒充已审查。'],table:{headers:['路径','排除原因'],rows:(m.sourceExclusions as any[]).slice(0,500).map(item=>[String(item.path),({'Binary or changing file excluded':'二进制资源，不进行源码审查','File exceeds 2 MB':'非源码资源超过单文件读取上限','Dependency or generated directory excluded':'依赖或生成目录，按索引策略排除','Ignored by .gitignore':'项目 .gitignore 明确排除','Credential file excluded':'凭据文件，按保密策略排除','Symbolic links excluded':'符号链接，按文件边界策略排除'} as Record<string,string>)[item.reason]||chinese(item.reason,'非源码或索引策略排除项，原始原因见 JSON')])}});
  }
  const gaps=[...(Array.isArray(m.workflowGaps)?m.workflowGaps as string[]:[]),...(Array.isArray(m.completionIssues)?m.completionIssues as string[]:[])];
  if(gaps.length){
    const reasons:[RegExp,string,string][]=[
      [/budget|token.*reserve|reserve.*token/i,'请求预算或预留额度不足','减少附加 Skill、审计范围或最大输出，或提高任务预算后重跑；上下文容量与任务预算是两项设置。'],
      [/timeout|timed out|超时/i,'模型请求超时','检查模型响应速度，并按需要调整请求超时或输出上限后重跑。'],
      [/summari[sz]|guidance.*consolidat/i,'审计规则整理未完成','检查模型返回与超时记录，减少不相关附加 Skill 后重跑。'],
      [/unassigned|unreviewed|deferred|reassignment|coverage.*incomplete/i,'源码覆盖或复审分配未完成','按原始记录定位未完成文件，缩小模块范围补审。'],
      [/schema|canonical_refs|semantic tuple|validator/i,'审计记录结构校验失败','检查重复覆盖标识或缺失字段；校验通过前不能声称审计完整。'],
      [/cancel|interrupt|task_timeout/i,'任务被取消或中断','检查中断原因并重新执行未完成范围。']
    ];
    const counts=new Map<string,{count:number;advice:string}>();
    for(const gap of gaps){const match=reasons.find(([pattern])=>pattern.test(gap));const name=match?.[1]||chinese(gap,'其他未完成检查，具体位置见下方原始记录');const row=counts.get(name)||{count:0,advice:match?.[2]||'结合原始记录检查具体阶段与错误，不将其视为已确认漏洞。'};row.count++;counts.set(name,row);}
    sections.push({title:'尚未完成的检查',lines:[`共 ${gaps.length} 条记录，按原因合并为 ${counts.size} 类；同一次失败可能影响多个阶段，记录条数不代表漏洞数量。`],table:{headers:['未完成原因','记录数','处理建议'],rows:[...counts].map(([name,row])=>[name,String(row.count),row.advice])}});
    sections.push({title:'未完成检查的原始记录',lines:['以下保留阶段、文件位置和原始错误标识，便于核对；重复原文仅列一次。'],code:[...new Set(gaps)].map((gap,index)=>`${index+1}. ${text(gap,2000)}`).join('\n').slice(0,32000)});
  }
  const flow=(Array.isArray(m.workflowPhases)?m.workflowPhases as string[]:[]).map(p=>phaseNames[p]||'审计检查');
  sections.push({title:'执行流程与证据说明',lines:[flow.length?flow.join(' → '):'尚无已执行阶段记录','文件路径、代码、命令和运行器日志保留原文，便于精确定位；正文结论以中文描述。']});
  sections.push({title:'附录：原始执行日志',code:task.logs.slice(-100).join('\n').slice(-32000)||'暂无执行日志。'});
  return sections;
}

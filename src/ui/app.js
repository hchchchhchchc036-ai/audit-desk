'use strict';

const $ = (id) => document.getElementById(id);
const tabs = [['overview', '总览', '▦'], ['audit', '代码审计', '◇'], ['test', '软件测试', '▤'], ['skills', 'Skill 与工具', '⊞'], ['settings', '模型与报告', '⚙']];
const statusNames = { queued: '排队中', running: '运行中', passed: '通过', failed: '失败', partial: '部分完成', cancelled: '已取消', blocked: '未执行', confirmed: '已确认', needs_validation: '待验证', rejected: '已驳回', candidate: '候选问题' };
let state = { project: null, tasks: [], skills: [], settings: {}, tools: { ocr: {}, docker: {} } };
let activeTab = 'overview';
let notificationTimer;
let editingSkill;
let diagramSequence = 0;
let telemetryTimer;
let telemetryStopped = false;
let clockTimer;
let contextBusy = false;
let runningToolId;

function updateHeaderClock() {
  const now = new Date();
  $('header-time').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  $('header-time').dateTime = now.toISOString();
  $('header-date').textContent = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function updateHeaderSystem(data) {
  const online = data.network?.online;
  $('header-network').textContent = typeof online === 'boolean' ? online ? 'ONLINE' : 'OFFLINE' : '--';
  $('header-network').className = typeof online === 'boolean' ? online ? 'system-online' : 'system-offline' : 'system-unknown';
  const battery = data.battery;
  let power = '--';
  if (battery?.present === false) power = 'AC / 无电池';
  else if (battery?.present === true && Number.isFinite(battery.percent)) power = `${Math.round(battery.percent)}%${battery.charging === true ? ' +' : ''}`;
  $('header-power').textContent = power;
  $('header-power').title = battery?.message || (battery?.charging === true ? '电池正在充电' : '本机电源状态');
  $('header-power').className = battery?.present === true && Number.isFinite(battery.percent) && battery.percent <= 20 && battery.charging !== true ? 'system-offline' : '';
}

function terminalBar(percent, width = 12) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const filled = Math.round(value / 100 * width);
  return `[${'|'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}
function byteSize(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}G`;
  return `${(value / 1024 ** 2).toFixed(0)}M`;
}
function compactNumber(value) { return Number.isFinite(value) ? value >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)) : '--'; }
function monitorRow(label, value, className = '') { return el('div', { class: `monitor-row ${className}` }, el('span', {}, label), el('span', {}, value)); }
function renderTelemetry(data) {
  updateHeaderSystem(data);
  const { cpu, memory, app, usage, progress } = data;
  const context = data.context?.projectId === state.project?.id ? data.context : null;
  const line = (name, percent) => el('div', { class: 'monitor-meter' }, el('span', {}, name), el('span', { class: 'monitor-bar' }, terminalBar(percent)), el('span', {}, `${Number(percent).toFixed(name === 'CTX' ? 2 : 0)}%`));
  const cores = Array.isArray(cpu.cores) ? cpu.cores : [];
  $('telemetry-content').replaceChildren(
    monitorRow('HOST / 整机', '[LIVE]', 'monitor-label'),
    line('CPU', cpu.percent),
    el('div', { class: 'core-meter' }, cores.slice(0, 4).map((percent, index) => el('span', {}, `${index}:${Number(percent).toFixed(0)}%`))),
    monitorRow('CORES', `${cores.length} 核${cores.length > 4 ? ' / 显示前4核' : ''}`),
    line('RAM', memory.percent),
    monitorRow('USED/TOTAL', `${byteSize(memory.usedBytes)}/${byteSize(memory.totalBytes)}`),
    monitorRow('APP CPU / RAM', `${Number(app.cpuPercent).toFixed(1)}% / ${byteSize(app.memoryBytes)}`),
    monitorRow('TASKS DONE', `${progress.done}/${progress.total}`, 'monitor-divider'),
    monitorRow('FILES REVIEWED', `${progress.reviewed}/${progress.files}`),
    monitorRow('TOKENS', `${compactNumber(usage.totalTokens)}${usage.estimated ? ' ~估算' : ''}`, 'monitor-divider'),
    monitorRow('IN / OUT', `${compactNumber(usage.inputTokens)}/${compactNumber(usage.outputTokens)}`),
    monitorRow('USAGE RECORDS', compactNumber(usage.calls)), monitorRow('MODEL', data.modelActivity || '等待任务'),
    ...(usage.ocrUnreportedTasks ? [monitorRow('OCR USAGE', `${usage.ocrUnreportedTasks} 次未报告`)] : []),
    line('CTX', context ? context.percent : usage.contextPercent),
    ...(context ? [monitorRow('MEMORY ~ / LIMIT', `${compactNumber(context.estimatedTokens)}/${compactNumber(context.capacityTokens)}`)] : []),
    monitorRow('LAST IN / LIMIT', `${compactNumber(usage.lastInputTokens)}/${compactNumber(usage.contextWindowTokens)}`),
    el('div', { class: 'monitor-clock' }, `${new Date(data.timestamp).toLocaleTimeString('zh-CN', { hour12: false })} / 2s · CTX 持久记忆估算`));
}
async function pollTelemetry() {
  try {
    const data = await window.audit.invoke('telemetry');
    if (!telemetryStopped && data?.cpu && data?.memory && data?.app && data?.usage && data?.progress) renderTelemetry(data);
  } catch {
    if (!telemetryStopped) { updateHeaderSystem({}); $('telemetry-content').replaceChildren(el('p', { class: 'monitor-pending' }, '[--] 遥测暂不可用\n等待本地服务…')); }
  } finally { if (!telemetryStopped) telemetryTimer = setTimeout(pollTelemetry, 2000); }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked' || key === 'disabled' || key === 'required') node[key] = Boolean(value);
    else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(text, handler, style = '', attrs = {}) { return el('button', { type: 'button', class: `button ${style}`, onclick: handler, ...attrs }, text); }
function badge(status) {
  const codes = { queued: 'WAIT', running: 'RUN', passed: 'OK', failed: 'ERR', partial: 'PART', cancelled: 'STOP', blocked: 'BLOCK', confirmed: 'CONF', needs_validation: 'VERIFY', rejected: 'REJECT', candidate: 'CAND' };
  return el('span', { class: `badge ${Object.hasOwn(statusNames, status) ? status : ''}` }, `[${codes[status] || 'INFO'}] ${statusNames[status] || status}`);
}
function notice(message, error = false) {
  clearTimeout(notificationTimer);
  $('notification').textContent = message;
  $('notification').className = `notification${error ? ' error' : ''}`;
  $('notification').hidden = false;
  notificationTimer = setTimeout(() => { $('notification').hidden = true; }, error ? 16000 : 6000);
}
async function invoke(action, payload, sourceButton) {
  if (sourceButton) sourceButton.disabled = true;
  try { return await window.audit.invoke(action, payload); }
  catch (error) {
    const message=error.message||String(error);
    notice(`位置：${action}\n原因：${message}\n下一步：${/ENOSPC|磁盘空间不足/.test(message)?'释放应用数据所在磁盘的空间后重试。':'检查当前项目、模型配置或工具状态后重试。'}`, true);
    throw error;
  } finally { if (sourceButton) sourceButton.disabled = false; }
}
function guarded(handler) { return (event) => { Promise.resolve().then(() => handler(event)).catch(() => {}); }; }
function heading(title, subtitle, tag) {
  return el('div', { class: 'page-heading' }, el('div', {}, el('div', { class: 'eyebrow' }, `user@audit-desk:~$ ${activeTab} --scope local`), el('h1', {}, title), el('p', { class: 'subtitle' }, subtitle)), tag ? el('span', { class: 'heading-tag' }, `[ ${tag} ]`) : null);
}
function panel(title, subtitle, children, action) {
  return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('h2', {}, title), subtitle ? el('p', { class: 'muted' }, subtitle) : null), action), children);
}
function empty(title, description, action) {
  return el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '◇'), el('h3', {}, title), el('p', {}, description), action);
}
function field(label, name, options = {}) {
  const { type = 'text', value = '', hint, placeholder, full, min, max, step, required } = options;
  const input = el('input', { id: name, name, type, value, placeholder, min, max, step, required, autocomplete: type === 'password' ? 'new-password' : 'off' });
  return el('div', { class: `field${full ? ' full' : ''}` }, el('label', { for: name }, label), input, hint ? el('p', { class: 'hint' }, hint) : null);
}
function selectField(label, name, options, value) {
  const select = el('select', { id: name, name }, options.map(([key, text]) => el('option', { value: key }, text)));
  select.value = value;
  return el('div', { class: 'field' }, el('label', { for: name }, label), select);
}
function textareaField(label, name, placeholder, hint) {
  return el('div', { class: 'field full' }, el('label', { for: name }, label), el('textarea', { id: name, name, placeholder, class: name === 'command' ? 'code-input' : '' }), hint ? el('p', { class: 'hint' }, hint) : null);
}
function check(label, name, value, checked = false, type = 'checkbox') {
  return el('label', { class: 'choice' }, el('input', { type, name, value, checked }), label);
}
function navigate(tab) {
  activeTab = tabs.some(t => t[0] === tab) ? tab : 'overview';
  document.querySelectorAll('.nav-button').forEach(node => {
    node.classList.toggle('active', node.dataset.tab === activeTab);
    if (node.dataset.tab === activeTab) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  render();
}
function render() {
  $('project-name').textContent = state.project?.name || '尚未选择项目';
  $('project-path').textContent = state.project?.root || '选择文件夹，开始建立本地索引';
  $('project-path').title = state.project?.root || '';
  $('rescan-project').disabled = !state.project;
  renderProjectSelect(); renderContext();
  $('connection-status').textContent = `${state.tasks.filter(t => ['queued', 'running'].includes(t.status)).length} 个活跃任务 · ${state.skills.filter(s => s.enabled).length} 个已启用 Skill`;
  const pages = { overview: renderOverview, audit: () => renderRun('audit'), test: () => renderRun('test'), skills: renderSkills, settings: renderSettings };
  $('main').replaceChildren(...pages[activeTab]());
}
async function refresh() {
  state = await invoke('state');
  if (state.settings?.keyError) notice(state.settings.keyError, true);
  state.tasks ||= []; state.skills ||= []; state.tools ||= { ocr: {}, docker: {} }; state.projects ||= []; state.customTools ||= [];
  render();
}
async function importProject(event) {
  const result = await invoke('project:import', undefined, event?.currentTarget);
  if (result) { await refresh(); notice(`已索引 ${result.files.length} 个文件：${result.name}`); }
}
function stat(label, value, foot, accent) { return el('div', { class: `stat${accent ? ' stat-accent' : ''}` }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value), el('div', { class: 'stat-foot' }, foot)); }
function stats() {
  const project = state.project;
  const tasks = project ? state.tasks.filter(t => t.projectId === project.id) : [];
  return el('div', { class: 'stats-grid', id: 'overview-stats' }, stat('索引文件', project?.files.length || 0, project ? `已读取 ${project.files.filter(f => f.status === 'read').length} · 跳过 ${project.files.filter(f => f.status === 'skipped').length}` : '选择项目后开始索引'), stat('项目模块', project?.modules.length || 0, project ? `${Object.keys(project.languages).length} 种语言` : '来自真实目录结构'), stat('任务记录', tasks.length, `${tasks.filter(t => ['running', 'queued'].includes(t.status)).length} 个任务正在处理`), stat('已确认问题', tasks.reduce((n, t) => n + t.findings.filter(f => f.status === 'confirmed').length, 0), '当前项目历史任务中的确认记录', true));
}
function toolPanel() {
  return panel('运行环境', '工具状态由本机检查', el('div', {},
    toolRow('模型服务', state.settings.keyError || state.settings.model || '尚未配置模型', Boolean(!state.settings.keyError && state.settings.model && state.settings.baseUrl)),
    toolRow('Open Code Review', state.tools.ocr?.message || '尚未检测', state.tools.ocr?.available),
    toolRow(state.settings.testExecution === 'docker' ? 'Docker 隔离环境' : '本地执行（默认）', state.settings.testExecution === 'docker' ? state.tools.docker?.message || '尚未检测' : '无需 Docker · 项目副本执行 · 当前用户权限', state.settings.testExecution !== 'docker' || state.tools.docker?.available),
    button('配置模型与工具 →', () => navigate('settings'), 'quiet')));
}
function toolRow(title, message, ready) { return el('div', { class: 'tool-row' }, el('div', {}, el('strong', {}, title), el('p', {}, message)), el('span', { class: `badge ${ready ? 'passed' : 'partial'}` }, ready ? '[OK] 已就绪' : '[WAIT] 待配置')); }
function renderOverview() {
  const project = state.project;
  const projectPanel = project ? panel('项目索引', `索引时间 ${date(project.indexedAt)} · 索引覆盖不等于审计覆盖`, el('div', {}, project.warnings.map(w => el('div', { class: 'warning' }, w)), el('div', { class: 'choice-list' }, Object.entries(project.languages).map(([name, count]) => el('span', { class: 'badge' }, `${name} · ${count}`))), fileTable(project.files)), button('开始代码审计 →', () => navigate('audit'), 'quiet')) : panel('从一个项目开始', '所有任务关联到实际导入的项目', empty('准备好检查你的代码', '选择本地文件夹，查看文件清单和模块，再按范围启动审计或测试。导入不会执行项目脚本。', button('选择项目文件夹', guarded(importProject), 'primary')));
  const guide = workflowPanel();
  const architecture = panel('项目架构', project ? '基于当前索引；关系依据以图中说明为准' : '导入项目后显示架构', project ? diagram(project.diagram, ['项目目录', '模块索引', '源文件']) : empty('暂无项目架构', '导入文件夹后生成项目结构图。'), project ? button('导出图文件', guarded(async e => { await invoke('diagram:export', undefined, e.currentTarget); }), 'quiet') : null);
  return [heading('项目总览', '让每一次检查都有范围、证据和可追溯的结果。', project ? '项目已导入' : '等待导入项目'), stats(), el('div', { class: 'columns' }, el('div', {}, projectPanel, architecture, panel('最近任务', '实时状态与检查结果', taskList('all', 5))), el('div', {}, guide, toolPanel()))];
}
function workflowTask() {
  if (!state.project) return null;
  const tasks = visibleTasks().filter(task => ['running', 'queued'].includes(task.status) || task.createdAt >= state.sessionStartedAt);
  return tasks.find(task => task.status === 'running') || tasks.find(task => task.status === 'queued') || tasks[0] || null;
}
function workflowSteps(task) {
  if(task.input?.toolIds?.length){const withoutTools={...task,input:{...task.input,toolIds:[]}};return [['custom-tools','模型选择与执行附加工具'],...workflowSteps(withoutTools)];}
  if (task.kind === 'test') return [['prepare', '准备环境'], ...(task.input?.generate ? [['modelgen', '生成用例']] : []), [task.metrics?.executionMode === 'local' ? 'local' : 'docker', task.metrics?.executionMode === 'local' ? '本地执行' : 'Docker 执行'], ['evidence', '采集证据'], ['report', '生成报告']];
  if (task.input?.engine === 'ocr') return [['preview', '范围预览'], ['ocr', 'OCR 扫描'], ['report', '生成报告']];
  return [['index', '索引范围'], ['recon', '项目侦察'], ['discovery', '发现问题'], ['verification', '证据验证'], ['schema', '结构校验'], ['report', '生成报告']];
}
function toolTrace(task, compact = false) {
  const events = Array.isArray(task.metrics?.flowEvents) ? task.metrics.flowEvents : [];
  const statusLabels = { running: 'RUN', completed: 'OK', failed: 'ERR', cancelled: 'STOP', blocked: 'BLOCK' };
  const items = events.map(event => {
    const model = /model|openai|anthropic|模型/i.test(String(event.tool));
    let duration = event.durationMs;
    if (!Number.isFinite(duration) && event.finishedAt) duration = new Date(event.finishedAt).getTime() - new Date(event.at).getTime();
    const elapsed = event.status === 'running' ? `等待 ${Math.max(0,Math.floor((Date.now()-Date.parse(event.at))/1000))}s` : Number.isFinite(duration) && duration >= 0 ? duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s` : '--';
    const item = el('details', { class: `trace-event trace-${Object.hasOwn(statusLabels, event.status) ? event.status : 'pending'}`, 'data-event-id': event.id || `${event.at}-${event.tool}` },
      el('summary', {}, el('span', { class: 'trace-code' }, `[${statusLabels[event.status] || '--'}]`), el('span', { class: 'trace-label' }, event.label || event.tool), el('span', { class: 'trace-duration', 'data-started-at': event.status==='running'?event.at:undefined, 'data-timeout-seconds': model?String(event.detail||'').match(/timeout_seconds=(\d+)/)?.[1]:undefined }, elapsed)),
      el('div', { class: 'trace-meta' }, `${model ? '模型 API' : '执行器工具'} / ${event.tool || '--'} / ${date(event.at)}`),
      event.detail ? el('pre', { class: 'trace-detail' }, String(event.detail)) : el('p', { class: 'hint' }, '执行器未提供附加详情。'));
    return item;
  });
  return el('section', { class: `tool-trace${compact ? ' compact-trace' : ''}` },
    el('div', { class: 'trace-heading' }, '实际调用记录', el('span', {}, `${events.length} 次`)),
    items.length ? el('div', { class: 'trace-items' }, items) : el('p', { class: 'hint trace-empty' }, ['queued', 'running'].includes(task.status) ? '准备中，尚未记录工具调用。' : '该任务未记录工具调用。'),
    task.input?.engine === 'ocr' ? el('p', { class: 'hint trace-ocr', title: 'CLI 未提供内部逐次工具记录；这里仅展示应用实际发起的命令。' }, 'OCR：展示 CLI 调用；内部工具步骤未报告。') : null);
}
function workflowPanel() {
  const task = workflowTask();
  let content;
  if (!task) content = el('div', {}, [['导入与索引', '读取可审查文件，保留排除原因。'], ['选择范围与工具', '多模块选择，明确模型和 Skill。'], ['检查证据与报告', '查看真实日志、源码位置和覆盖缺口。']].map(([title, text], index) => el('div', { class: 'step' }, el('span', { class: 'step-number' }, index + 1), el('div', {}, el('strong', {}, title), el('p', {}, text)))));
  else {
    const steps = workflowSteps(task);
    const aliases = { reconnaissance: 'recon', discover: 'discovery', verify: 'verification', validation: 'schema', reporting: 'report', 'ocr-scan': 'ocr', 'model-generation': 'modelgen', execution: 'docker', collect: 'evidence', scope: task.input?.engine === 'ocr' ? 'preview' : 'index' };
    const recordedPhase = task.metrics?.workflowPhase || task.metrics?.progress?.phase;
    const phase = aliases[recordedPhase] || recordedPhase;
    const phaseIndex = steps.findIndex(([key]) => key === phase);
    const finished = !['queued', 'running'].includes(task.status);
    const history = Array.isArray(task.metrics?.workflowPhases) ? task.metrics.workflowPhases : [];
    const lastWorkPhase = history.filter(key => key !== 'report').at(-1);
    const nodes = steps.flatMap(([key, label], index) => {
      let status = 'pending';
      if (history.includes(key) && key !== phase) status = finished && task.status !== 'passed' && key === lastWorkPhase ? task.status : 'completed';
      else if (index === phaseIndex) status = finished ? task.status === 'passed' && history.includes(key) ? 'completed' : ['failed', 'blocked', 'cancelled'].includes(task.status) ? task.status : 'partial' : task.status === 'queued' ? 'pending' : 'running';
      if (finished && key === 'report' && task.reportDir && history.includes(key)) status = 'completed';
      return [index ? el('span', { class: 'live-link', 'aria-hidden': 'true' }, '│') : null, el('div', { class: `live-node node-${status}`, 'data-phase': key, 'data-phase-status': status }, el('span', { class: 'node-code' }, ({ pending: '[..]', completed: '[OK]', running: '[>>]', failed: '[ERR]', blocked: '[BLOCK]', cancelled: '[STOP]', partial: '[PART]' })[status]), el('span', {}, label))];
    });
    content = el('div', {}, el('div', { class: 'workflow-task-label' }, el('span', {}, task.title), badge(task.status)), el('div', { class: 'live-flow', 'aria-label': '当前任务执行阶段' }, nodes), phaseIndex < 0 && task.status !== 'passed' ? el('p', { class: 'hint' }, '等待执行器提供阶段状态；工具调用记录见下方。') : null, toolTrace(task, true));
  }
  const result = panel('工作流程', task ? '当前项目 · 优先显示运行中任务，完成后保留结果' : null, content);
  result.id = 'live-workflow';
  if (task) result.dataset.taskId = task.id;
  return result;
}
function fileTable(files) {
  const table = el('table', { class: 'file-table' }, el('thead', {}, el('tr', {}, ['文件', '状态', '说明'].map(t => el('th', { scope: 'col' }, t)))));
  table.append(el('tbody', {}, files.slice(0, 200).map(f => el('tr', {}, el('td', {}, f.path), el('td', {}, f.status === 'read' ? '已读' : f.status === 'skipped' ? '跳过' : '失败'), el('td', {}, f.reason || f.language || '—')))));
  return el('div', {}, el('div', { class: 'table-scroll' }, table), files.length > 200 ? el('p', { class: 'hint' }, `显示前 200 个文件，共 ${files.length} 个；完整覆盖记录见任务报告。`) : null);
}
function diagram(source, fallback) {
  const host = el('div', { class: 'diagram' });
  const fallbackNodes = () => {
    host.replaceChildren(el('div', { class: 'flow-fallback' }, fallback.flatMap((text, index) => [index ? el('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, '→') : null, el('span', { class: 'flow-node' }, text)])), source ? el('details', {}, el('summary', {}, '查看 Mermaid 图源'), el('pre', { class: 'diagram-source' }, source)) : []);
  };
  fallbackNodes();
  if (source && window.mermaid) {
    const id = `audit-diagram-${++diagramSequence}`;
    window.mermaid.render(id, source).then(({ svg }) => {
      if (!host.isConnected) return;
      // Mermaid's strict renderer produces SVG; parse it without interpolating HTML.
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror')) return;
      const root = parsed.documentElement;
      root.setAttribute('role', 'img'); root.setAttribute('aria-label', '流程与架构图');
      host.replaceChildren(document.importNode(root, true));
    }).catch(fallbackNodes);
  }
  return host;
}
function scopePicker() {
  const scopes = el('div', { class: 'choice-list scope-list' }, check('整个项目', 'scopes', '.', true), (state.project?.modules || []).filter(m => m !== '.').map(m => check(m, 'scopes', m)));
  scopes.addEventListener('change', event => {
    if (event.target.value === '.' && event.target.checked) scopes.querySelectorAll('input').forEach(i => { if (i.value !== '.') i.checked = false; });
    else if (event.target.checked) scopes.querySelector('input[value="."]').checked = false;
  });
  return el('fieldset', { class: 'form-section' }, el('legend', {}, '01 / 检查范围'), scopes, el('p', { class: 'hint' }, '可选择多个模块；整个项目与模块选择互斥。'));
}
function skillPicker() {
  const skills = state.skills.filter(s => s.enabled);
  return el('fieldset', { class: 'form-section' }, el('legend', {}, '03 / 附加 Skill'), skills.length ? el('div', { class: 'choice-list' }, skills.map(s => check(s.name, 'skillIds', s.id))) : el('p', { class: 'hint' }, '暂无已启用的 Skill。可前往 Skill 库导入；不选择也能运行内置流程。'));
}
function renderRun(kind) {
  const audit = kind === 'audit';
  const form = el('form', { id: 'run-form', onsubmit: guarded(event => startTask(event, kind)) }, scopePicker());
  if (audit) form.append(el('div', { class: 'form-section' }, el('div', { class: 'form-grid' }, selectField('02 / 审计引擎', 'engine', [['security-audit', 'security-audit · 证据审查'], ['ocr', 'Open Code Review · 本地 CLI']], 'security-audit')), el('p', { class: 'hint' }, 'OCR 与内置审查共用“模型与报告”中的模型配置。')));
  else form.append(el('fieldset', { class: 'form-section' }, el('legend', {}, '02 / 测试类型 · 可多选'), el('div', { class: 'choice-list' }, button('全选', () => {form.querySelectorAll('input[name="testType"]').forEach(node=>node.checked=true);form.dispatchEvent(new Event('change'));},'quiet',{id:'select-all-tests'}), button('清空选择', () => {form.querySelectorAll('input[name="testType"]').forEach(node=>node.checked=false);form.dispatchEvent(new Event('change'));},'quiet',{id:'clear-tests'})), el('div', { class: 'type-tabs' }, [['unit', '单元测试'], ['functional', '功能测试'], ['automation', '自动化测试'], ['performance', '性能测试']].map(([value, text], index) => check(text, 'testType', value, index === 0))),el('p',{class:'hint'},'所选类型分别排队执行、分别生成报告；选中性能测试后可设置负载参数。')));
  form.append(skillPicker(), customToolPicker(), textareaField(audit ? '审查重点（可选）' : '测试目标与预期', 'objective', audit ? '例如：重点检查身份认证、权限边界和敏感信息处理' : '说明用户操作、输入、预期结果或需要验证的性能目标', '明确预期有助于区分探索检查与业务验收。'));
  if (!audit) {
    form.append(el('div', { class: 'form-section', style: 'margin-top:18px' }, textareaField('执行命令 · JSON 参数数组', 'command', '["npm", "test", "--", "--run"]', '每个参数独立填写。默认在本地项目副本执行，无需 Docker。留空且取消生成时仅尝试发现现有 Node 测试。'), check('使用当前模型生成测试计划 / 用例', 'generate', 'true', true), el('div', { class: 'form-grid', id: 'performance-fields', hidden: true }, field('持续时间（秒）', 'durationSeconds', { type: 'number', value: 30, min: 1, max: 600 }), field('并发数', 'testConcurrency', { type: 'number', value: 1, min: 1, max: 100 }), field('延迟阈值（毫秒）', 'thresholdMs', { type: 'number', value: 1000, min: 1 }))));
    form.addEventListener('change', () => { $('performance-fields').hidden = !new FormData(form).getAll('testType').includes('performance'); });
    form.append(el('p',{class:'hint'},'多选测试共用命令时，可将一个独立参数写为 {testType}，软件会依次替换为 unit / functional / automation / performance。使用已验证命令时取消模型生成。'));
  }
  if(!audit)form.append(check('模型生成测试失败时，允许自动修正测试脚本（最多 2 次，保留首次失败证据）','autoRepair','true',true));
  form.append(el('div', { class: 'form-footer' }, el('p', { class: 'hint' }, audit ? '提交前会再次确认模型地址与将发送的代码范围。' : '默认在本地项目副本运行，使用当前用户权限。Docker 可在模型与报告中选用。'), el('button', { type: 'submit', class: 'button primary', disabled: !state.project }, audit ? '开始审计 →' : '开始测试 →')));
  const info = panel(audit ? '审计流程' : '测试流程', '每个阶段保留实际执行证据', diagram(null, audit ? ['建立覆盖计划', '审查源文件', '验证问题', '输出报告'] : ['选择测试范围', '准备隔离环境', '运行与采证', '输出报告']));
  return [heading(audit ? '代码审计' : '软件测试', audit ? '从文件范围到源码证据，逐项追踪审查结果。' : '复用已有用例，按明确预期验证真实行为。', audit ? '源项目只读' : '隔离工作区执行'), !state.project ? el('div', { class: 'notice' }, '先选择顶部的“选择项目文件夹”，再配置检查范围。') : null, el('div', { class: 'columns' }, el('div', {}, panel(audit ? '配置审计任务' : '配置测试任务', state.project ? `当前项目：${state.project.name}` : '等待选择项目', form), panel(audit ? '审计任务' : '测试任务', '点击任务详情查看日志、证据与导出选项', taskList(kind))), el('div', {}, info, toolPanel()))];
}
async function startTask(event, kind) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const scopes = data.getAll('scopes');
  if (!scopes.length) { notice('位置：检查范围\n原因：尚未选择模块\n下一步：勾选整个项目或至少一个模块。', true); return; }
  const input = { kind, scopes, skillIds: data.getAll('skillIds'), toolIds: data.getAll('toolIds'), objective: String(data.get('objective') || '').trim() };
  if (kind === 'audit') input.engine = data.get('engine');
  else {
    input.testTypes = data.getAll('testType');
    if(!input.testTypes.length){notice('请至少选择一种测试类型。',true);return;}
    input.testType = input.testTypes[0]; input.generate = data.has('generate');input.autoRepair=data.has('autoRepair');
    const command = String(data.get('command') || '').trim();
    if (command) {
      try { input.command = JSON.parse(command); if (!Array.isArray(input.command) || !input.command.length || !input.command.every(arg => typeof arg === 'string' && !arg.includes('\0')) || !input.command[0].trim()) throw new Error(); }
      catch { notice('位置：执行命令\n原因：必须是非空字符串组成的 JSON 数组\n下一步：使用 ["npm", "test"] 这样的格式。', true); $('command').focus(); return; }
    }
    if (input.testTypes.includes('performance')) { input.durationSeconds = Number(data.get('durationSeconds')); input.concurrency = Number(data.get('testConcurrency')); input.thresholdMs = Number(data.get('thresholdMs')); }
  }
  if (kind === 'audit' || input.generate) {
    if (!window.confirm(`确认向模型服务发送代码？\n\n模型地址：${state.settings.baseUrl || '尚未配置'}\n模型：${state.settings.model || '尚未配置'}\n项目：${state.project.name}\n代码范围：${scopes.join('、')}\nSkill：${input.skillIds.length} 个\n\n所选范围的可读取源文件及关联说明会交给该模型服务。`)) return;
  }
  if ((kind === 'test' || input.toolIds.length) && state.settings.testExecution !== 'docker' && !window.confirm('将在本机项目副本执行测试或工具，使用当前 Windows 用户权限，可访问本机文件和网络。确认运行此受信任项目？')) return;
  const result = await invoke('task:start', input, form.querySelector('[type="submit"]'));
  for(const task of Array.isArray(result)?result:[result])upsertTask(task);
  notice(Array.isArray(result)?`已提交 ${result.length} 个测试任务，将依次执行并分别生成报告。`:'任务已提交。下方任务卡片会显示真实进度。');
}
function date(value) { const result = new Date(value); return Number.isNaN(result.getTime()) ? String(value || '—') : result.toLocaleString('zh-CN', { hour12: false }); }
function visibleTasks(kind = 'all') { return state.tasks.filter(t => (!state.project || t.projectId === state.project.id) && (kind === 'all' || t.kind === kind)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
function taskList(kind, limit) {
  const tasks = visibleTasks(kind);
  return el('div', { class: 'task-list', 'data-kind': kind, ...(limit ? { 'data-limit': limit } : {}) }, tasks.length ? tasks.slice(0, limit).map(taskCard) : empty('暂无任务记录', '运行一次审计或测试后，这里会显示实际进度、日志与报告。'));
}
function taskCard(task) {
  const total = task.coverage?.total || 0; const reviewed = task.coverage?.reviewed || 0;
  const details = el('details', { class: 'task-details', 'data-task-id': task.id }, el('summary', {}, `查看详情 · ${task.findings?.length || 0} 条问题记录`), el('p', { class: 'hint' }, task.summary || '尚无任务摘要'), el('p', { class: 'hint' }, `范围：${task.input?.scopes?.join('、') || '—'} · 已审查 ${reviewed} / ${total} · 跳过 ${task.coverage?.skipped || 0}`), el('div', { class: 'coverage-bar' }, el('span', { style: `width:${total ? Math.min(100, reviewed / total * 100) : 0}%` })), el('h3', {}, '运行日志'), el('pre', { class: 'log-output', tabindex: '0', 'aria-label': '任务运行日志' }, task.logs?.join('\n') || '等待执行器写入日志。'), task.metrics && Object.keys(task.metrics).length ? el('details', {}, el('summary', {}, '运行指标'), el('pre', {}, JSON.stringify(task.metrics, null, 2))) : null, (task.findings || []).map(findingCard), task.diagram ? diagram(task.diagram, ['检查范围', '执行任务', '采集证据', '结果报告']) : null);
  details.append(toolTrace(task));
  const actions = el('div', { class: 'task-actions' });
  if (['running', 'queued'].includes(task.status)) actions.append(button('取消任务', guarded(async e => { await invoke('task:cancel', { id: task.id }, e.currentTarget); notice('已发送取消请求，等待受管任务退出。'); }), 'danger'));
  if (task.reportDir) {
    if(task.kind==='audit'&&task.input.engine!=='ocr'&&['cancelled','partial'].includes(task.status)&&task.metrics?.jobs?.length&&!task.input.toolIds?.length)actions.append(button('继续未完成审计',guarded(async e=>{await invoke('task:start',{...task.input,resumeFromTaskId:task.id},e.currentTarget);await refresh();}),'',{disabled:!state.project||state.project.id!==task.projectId}));
    for (const [format, label] of [['docx', '打开中文 Word'], ['html', '中文 HTML'], ['md', '中文 MD'], ['json', 'JSON 数据']]) actions.append(button(label, guarded(async e => { await invoke('report:open', { id: task.id, format }, e.currentTarget); })));
    actions.append(button('导出中文 Word', guarded(async e => { const source=e.currentTarget;const original=source.textContent;source.textContent='正在生成中文 Word…';try{const result=await invoke('report:export',{id:task.id},source);if(result)notice('中文 Word 报告已保存：'+result.path);}finally{source.textContent=original;} }), '', {disabled:['running','queued'].includes(task.status)}));
    actions.append(button('导出证据包', guarded(async e => { const result=await invoke('report:exportEvidence',{id:task.id},e.currentTarget);if(result)notice('证据包已导出：'+result.path); })));
  }
  return el('article', { class: 'task-card' }, el('div', { class: 'task-title' }, el('h3', {}, task.title || (task.kind === 'audit' ? '代码审计' : '软件测试')), badge(task.status)), el('div', { class: 'task-meta' }, `${task.projectName} · ${date(task.createdAt)} · ${task.id}`), details, actions);
}
function findingCard(finding) {
  return el('article', { class: 'finding' }, badge(finding.status), finding.severity ? el('span', { class: 'badge' }, finding.severity) : null, el('h4', {}, finding.title), el('p', {}, `${finding.path || '未知文件'}:${finding.line || '—'}${finding.engine ? ` · ${finding.engine}` : ''}`), el('p', {}, finding.detail), finding.evidence ? el('div', {}, el('strong', { class: 'hint' }, '源代码 / 验证证据'), el('pre', {}, finding.evidence)) : null, finding.recommendation ? el('p', {}, `修复建议：${finding.recommendation}`) : null);
}
function upsertTask(task) {
  if (!task?.id) return;
  const index = state.tasks.findIndex(t => t.id === task.id);
  if (index >= 0) state.tasks[index] = task; else state.tasks.push(task);
  if (state.project && task.projectId !== state.project.id) return;
  renderContext();
  document.querySelectorAll('.task-list').forEach(node => {
    const opened = new Set([...node.querySelectorAll('details[open][data-task-id]')].map(d => d.dataset.taskId));
    const kind = node.dataset.kind; const limit = node.dataset.limit ? Number(node.dataset.limit) : undefined;
    const replacement = taskList(kind, limit);
    replacement.querySelectorAll('details[data-task-id]').forEach(d => { d.open = opened.has(d.dataset.taskId); });
    node.replaceWith(replacement);
  });
  if ($('overview-stats')) $('overview-stats').replaceWith(stats());
  if ($('live-workflow')) {
    const openEvents = new Set([...$('live-workflow').querySelectorAll('.trace-event[open]')].map(node => node.dataset.eventId));
    const next = workflowPanel();
    next.querySelectorAll('.trace-event').forEach(node => { node.open = openEvents.has(node.dataset.eventId); });
    $('live-workflow').replaceWith(next);
  }
  $('connection-status').textContent = `${state.tasks.filter(t => ['queued', 'running'].includes(t.status)).length} 个活跃任务 · ${state.skills.filter(s => s.enabled).length} 个已启用 Skill`;
}
function renderSkills() {
  const githubForm = el('form', { class: 'stack', onsubmit: guarded(async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const result = await invoke('skill:importGithub', { repo: data.get('repo').trim(), path: data.get('skillPath').trim(), ref: data.get('ref').trim() || undefined }, event.currentTarget.querySelector('[type=submit]'));
    if (result) { await refresh(); notice(`已导入 ${result.name}。请检查内容与依赖后启用。`); }
  }) }, field('GitHub 仓库', 'repo', { placeholder: 'owner/repository 或 GitHub 仓库 URL', required: true }), field('Skill 相对路径', 'skillPath', { placeholder: 'skills/example', hint: '填写仓库内包含 SKILL.md 的目录。' }), field('分支 / 标签 / 提交（可选）', 'ref', { placeholder: '留空使用默认分支' }), el('button', { class: 'button primary', type: 'submit' }, '获取并导入 Skill'));
  const cards = state.skills.length ? el('div', {}, state.skills.map(skill => el('article', { class: 'skill-card' }, el('div', { class: 'skill-head' }, el('h3', {}, skill.name), el('label', { class: 'choice' }, el('input', { type: 'checkbox', checked: skill.enabled, 'aria-label': `启用 ${skill.name}`, onchange: guarded(async e => { try { await invoke('skill:enable', { id: skill.id, enabled: e.target.checked }, e.target); await refresh(); } catch { e.target.checked = !e.target.checked; } }) }), '启用')), el('p', {}, skill.description), el('div', { class: 'skill-metadata' }, `来源：${skill.source}\n`, el('div', {}, `版本：${skill.sha || skill.hash} · 许可：${skill.license || '未声明'}`), el('div', {}, `${skill.stars === undefined ? '' : `仓库星数快照：${skill.stars} · `}导入于 ${date(skill.installedAt)}`), el('div', {}, `本地副本：${skill.path}`)), (skill.warnings || []).map(w => el('div', { class: 'warning' }, w)), el('div', { class: 'inline-actions' }, button('查看 / 编辑内容', guarded(async e => {
    const result = await invoke('skill:inspect', { id: skill.id }, e.currentTarget); editingSkill = skill.id; $('skill-dialog-title').textContent = skill.name; $('skill-content').value = result.content; $('skill-dialog').showModal();
  }), 'quiet'), button('移除', guarded(async e => { if (!window.confirm(`移除应用内的 Skill 副本“${skill.name}”？`)) return; await invoke('skill:remove', { id: skill.id }, e.currentTarget); await refresh(); }), 'danger'))))) : empty('你的 Skill 库还是空的', '导入本地 SKILL.md、Skill 文件夹或 GitHub 仓库中的具体 Skill。');
  return [customToolsPanel(), heading('Skill 库', '管理检查规范与参考资料，为任务选择需要的能力。', `${state.skills.filter(s => s.enabled).length} / ${state.skills.length} 已启用`), el('div', { class: 'columns' }, panel('已安装 Skill', '导入不执行脚本；任务只加载选中的已启用副本', cards), el('div', {}, panel('从本地导入', '支持单个 SKILL.md 或完整 Skill 文件夹', el('div', {}, el('p', { class: 'hint' }, '通过本机选择器选择文件或文件夹。关联引用文件保留目录结构。'), button('选择本地文件 / 文件夹', guarded(async e => { const result = await invoke('skill:importLocal', undefined, e.currentTarget); if (result) { await refresh(); notice(`已导入 ${result.name}`); } }), 'primary'))), panel('从 GitHub 导入', '联网获取由本地服务完成', githubForm)))];
}
function renderSettings() {
  const s = state.settings;
  const form = el('form', { id: 'settings-form', onsubmit: guarded(saveSettings) }, el('div', { class: 'form-grid' }, selectField('模型协议', 'protocol', [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic']], s.protocol || 'openai'), field('模型名称', 'model', { value: s.model, placeholder: '模型服务实际支持的名称', required: true }), field('Base URL', 'baseUrl', { value: s.baseUrl, placeholder: 'https://api.example.com/v1', full: true, type: 'url', required: true, hint: '支持本地兼容服务。模型调用和 OCR 使用同一地址、模型与密钥。' }), field('API Key', 'apiKey', { type: 'password', placeholder: s.keyError ? '旧密钥无法解密，请重新填写' : s.hasApiKey ? '已保存密钥；留空保持不变' : '填写模型 API Key；本地服务可留空', full: true }), el('div', { class: 'field full' }, check('明确清除已保存的 API Key', 'clearKey', 'true')), field('调用超时（秒）', 'timeoutSeconds', { type: 'number', value: s.timeoutSeconds || 120, min: 5, max: 1800, required: true }), field('输入字符上限', 'maxInputChars', { type: 'number', value: s.maxInputChars || 60000, min: 1000, max: 6000000, required: true }), contextCapacityField(s.contextWindowTokens || 32768), field('最大输出 token', 'maxOutputTokens', { type: 'number', value: s.maxOutputTokens || 4096, min: 128, max: 32000, required: true, hint: '修改并保存后，运行中内置模型任务从下一次请求同步；已发出的请求仍使用原上限。' }), field('模型并发数', 'concurrency', { type: 'number', value: s.concurrency || 1, min: 1, max: 8, required: true }), field('整个任务累计 token 预算（与上下文容量独立）', 'tokenBudget', { type: 'number', value: s.tokenBudget || 100000, min: 1000, max: 5000000, required: true, full: true }), selectField('测试 / 工具执行方式', 'testExecution', [['local', '本地运行（默认，无需 Docker）'], ['docker', 'Docker 隔离运行（可选）']], s.testExecution || 'local'), field('Docker 镜像（仅 Docker 模式）', 'containerImage', { value: s.containerImage || 'node:22-bookworm', required: true, full: true, hint: '仅 Docker 模式使用。默认本地模式不检测、不启动 Docker。' }), field('OCR 可执行路径（可选）', 'ocrPath', { value: s.ocrPath || '', placeholder: '留空从本机 PATH 发现 ocr', full: true })), el('div', { class: 'settings-buttons' }, el('button', { type: 'submit', class: 'button primary' }, '保存配置'), button('测试已保存的连接', guarded(async e => { const result = await invoke('model:test', undefined, e.currentTarget); notice(result.message || '模型连接验证成功。'); })), button('安装 / 检测 OCR', guarded(async e => { const result = await invoke('ocr:install', undefined, e.currentTarget); state.tools.ocr = result; notice(result.message || (result.available ? 'OCR 已就绪' : 'OCR 尚未就绪'), !result.available); }))), el('p', { class: 'hint', style: 'margin-top:12px' }, '修改配置后先保存，再测试连接。密钥不在界面回显，也不写入项目或报告。'));
  form.addEventListener('change', capacityPreview);
  form.querySelector('.form-grid').append(selectField('DeepSeek 官方型号思考模式', 'thinkingMode', [['disabled','标准模式（默认）'],['enabled','深度思考（更慢、更多 Token）'],['auto','遵循服务默认']], s.thinkingMode || 'disabled'));
  return [heading('模型与报告', '集中设置模型、执行工具与本地报告。', '配置保存在本机'), el('div', { class: 'columns' }, el('div', {}, panel('模型与执行配置', '审计、测试生成及 OCR 共用此配置', el('div', {}, s.keyError ? el('div', {class:'notice'}, s.keyError) : null, form))), el('div', {}, toolPanel(), panel('报告归档', state.project ? `当前项目：${state.project.name}` : '全部本地任务', taskList('all'))))];
}
async function saveSettings(event) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = {};
  for (const name of ['protocol', 'baseUrl', 'model', 'apiKey', 'ocrPath', 'containerImage', 'testExecution','thinkingMode']) payload[name] = String(data.get(name) || '').trim();
  for (const name of ['timeoutSeconds', 'maxInputChars', 'maxOutputTokens', 'concurrency', 'tokenBudget', 'contextWindowTokens']) payload[name] = Number(data.get(name));
  payload.clearKey = data.has('clearKey');
  await invoke('settings:save', payload, form.querySelector('[type=submit]'));
  $('apiKey').value = ''; await refresh(); notice('模型与执行配置已保存。现在可测试连接。');
}


function contextCapacityField(value) {
  const options = [[8192, '8K'], [16384, '16K'], [32768, '32K'], [65536, '64K'], [131072, '128K'], [262144, '256K'], [524288, '512K'], [1000000, '1M'], [2000000, '2M']];
  if (!options.some(([tokens]) => tokens === value)) options.push([value, '自定义 · ' + value]);
  return el('div', {}, selectField('模型上下文容量（token）', 'contextWindowTokens', options, String(value)), el('p', { id: 'capacity-preview', class: 'hint' }, '容量预览：' + value.toLocaleString() + ' token；保存后用于监控。模型需实际支持此容量。'));
}
function capacityPreview(event) {
  if (!['contextWindowTokens', 'maxOutputTokens'].includes(event.target.name)) return;
  const tokens = Number($('contextWindowTokens').value);
  $('maxInputChars').value = String(Math.min(6000000, Math.max(Number($('maxInputChars').value), Math.max(1000, tokens * 3 - Number($('maxOutputTokens').value) * 3))));
  $('capacity-preview').textContent = '容量预览：' + tokens.toLocaleString() + ' token；保存后用于监控。模型需实际支持此容量。';
}
function renderProjectSelect() {
  $('project-select').replaceChildren(el('option', { value: '' }, '切换项目'), ...(state.projects || []).map(project => el('option', { value: project.id }, project.name)));
  $('project-select').value = state.project?.id || '';
  $('project-select').disabled = !(state.projects || []).length;
  $('open-context').disabled = !state.project;
}
async function selectProject(id) {
  if (!id || id === state.project?.id) return;
  state = await invoke('project:select', { id }, $('project-select'));
  render(); renderProjectManager();
}
function renderProjectManager() {
  $('projects-list').replaceChildren(...(state.projects || []).map(project => el('article', { class: 'skill-card' }, el('h3', {}, project.name), el('p', { class: 'hint' }, project.root), el('p', { class: 'hint' }, '索引：' + date(project.indexedAt) + ' · 上下文：' + (project.contextId || '待创建') + (project.id === state.project?.id && state.context ? ' · generation ' + state.context.generation : '')), el('div', { class: 'inline-actions' }, button(project.id === state.project?.id ? '当前项目' : '切换', guarded(() => selectProject(project.id)), '', { disabled: project.id === state.project?.id }), button('从列表移除', guarded(async event => {
    if (!window.confirm('从项目列表移除“' + project.name + '”？\n源项目文件不会删除；应用历史记录保留。')) return;
    state = await invoke('project:archive', { id: project.id }, event.currentTarget); render(); renderProjectManager();
  }), 'danger')))));
  if (!state.projects?.length) $('projects-list').append(el('p', { class: 'hint' }, '尚未导入项目。'));
}
function renderContext() {
  const projectId = state.project?.id;
  $('context-project').textContent = state.project ? '当前项目：' + state.project.name : '请选择项目';
  const context = state.context?.projectId === projectId ? state.context : null;
  $('context-metadata').textContent = context ? '上下文 ' + context.id + ' · generation ' + context.generation + ' · ' + context.messages.length + ' 条记忆记录' + (context.summary ? ' · 已有压缩摘要' : '') + (context.handoffPath ? ' · 交接文档已保存' : '') : '尚无项目上下文';
  if (context?.warning) $('context-metadata').textContent += ' · [WARN] ' + context.warning;
  $('open-handoff').hidden = !context?.handoffPath;
  const running = visibleTasks().some(task => ['running', 'queued'].includes(task.status));
  const reason = !context ? '请先选择项目' : contextBusy ? '正在处理上下文，请等待完成' : running ? '项目任务运行中，完成或取消任务后可压缩 / 重置' : '';
  if (reason) $('context-metadata').textContent += ' · [WAIT] ' + reason;
  for (const id of ['compress-context', 'reset-context']) { $(id).disabled = !!reason; $(id).title = reason; }
}
async function changeContext(action, source) {
  if (action === 'context:reset' && !window.confirm('先写交接文档再创建新上下文，旧记录保留。确认重置当前项目上下文？')) return;
  const projectId = state.project?.id;
  contextBusy = true; const original = source.textContent; source.textContent = '正在处理…'; renderContext();
  try { const result = await invoke(action); if (state.project?.id === projectId) state.context = result; notice(action === 'context:reset' ? '交接已保存，新上下文已创建。' : '上下文已压缩，原记录保留。'); }
  finally { contextBusy = false; source.textContent = original; renderContext(); }
}
function commandArray(text, allowEmpty = false) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some(arg => typeof arg !== 'string' || arg.includes('\0')) || (!allowEmpty && !value[0].trim())) throw new Error('请输入 JSON 字符串数组，例如 ["npm","test"]。');
  return value;
}
function customToolPicker() {
  const tools = (state.customTools || []).filter(tool => tool.enabled);
  return el('fieldset', { class: 'form-section' }, el('legend', {}, '附加容器工具（默认不选）'), tools.length ? el('div', { class: 'choice-list' }, tools.map(tool => check(tool.name, 'toolIds', tool.id))) : el('p', { class: 'hint' }, '在 Skill 与工具中注册并启用审计 / 测试工具。'), el('p', { class: 'hint' }, '模型仅可选择本次勾选的工具；命令在只读、无外网容器执行。'));
}
function customToolsPanel() {
  const tools = state.customTools || [];
  return panel('自定义命令工具', '默认在本地项目副本运行，使用当前用户权限；可在设置改为 Docker 隔离执行', el('div', {}, tools.length ? tools.map(tool => el('article', { class: 'skill-card' }, el('div', { class: 'skill-head' }, el('h3', {}, tool.name), el('label', { class: 'choice' }, el('input', { type: 'checkbox', checked: tool.enabled, 'aria-label': '启用工具 ' + tool.name, onchange: guarded(async event => {
    try { await invoke('tool:enable', { id: tool.id, enabled: event.target.checked }, event.target); await refresh(); } catch { event.target.checked = !event.target.checked; }
  }) }), '启用')), el('p', {}, tool.description), el('pre', {}, JSON.stringify(tool.command)), el('p', { class: 'hint' }, state.settings.testExecution === 'docker' ? (tool.image || '使用配置中的 Docker 镜像') : '本地运行 / 当前用户权限'), el('div', { class: 'inline-actions' }, button('编辑', () => openTool(tool)), button('运行', () => { runningToolId = tool.id; $('tool-run-title').textContent = tool.name; $('tool-args').value = '[]'; $('tool-result').textContent = '等待执行。'; $('tool-run-dialog').showModal(); }, '', { disabled: !tool.enabled || !state.project }), button('移除', guarded(async event => { if (!window.confirm('移除工具“' + tool.name + '”？')) return; await invoke('tool:remove', { id: tool.id }, event.currentTarget); await refresh(); }), 'danger')))) : el('p', { class: 'hint' }, '尚未注册工具。'), button('注册工具', () => openTool(), 'primary')));
}
function openTool(tool) {
  $('tool-id').value = tool?.id || ''; $('tool-name').value = tool?.name || ''; $('tool-description').value = tool?.description || ''; $('tool-command').value = tool ? JSON.stringify(tool.command) : ''; $('tool-image').value = tool?.image || ''; $('tool-enabled').checked = tool?.enabled ?? true; $('tool-dialog').showModal();
}
$('project-select').addEventListener('change', guarded(event => selectProject(event.target.value)));
$('manage-projects').addEventListener('click', () => { renderProjectManager(); $('projects-dialog').showModal(); });
for (const [buttonId, dialogId] of [['close-projects', 'projects-dialog'], ['close-context', 'context-dialog'], ['close-tool', 'tool-dialog'], ['close-tool-run', 'tool-run-dialog']]) $(buttonId).addEventListener('click', () => $(dialogId).close());
$('open-context').addEventListener('click', guarded(async () => { const projectId = state.project?.id; const context = await invoke('context:get'); if (projectId !== state.project?.id) return; state.context = context; renderContext(); $('context-dialog').showModal(); }));
$('compress-context').addEventListener('click', guarded(event => changeContext('context:compress', event.currentTarget)));
$('reset-context').addEventListener('click', guarded(event => changeContext('context:reset', event.currentTarget)));
$('open-handoff').addEventListener('click', guarded(event => invoke('context:handoffOpen', undefined, event.currentTarget)));
$('tool-form').addEventListener('submit', guarded(async event => {
  event.preventDefault(); let command;
  try { command = commandArray($('tool-command').value); } catch (error) { notice('位置：工具命令\n原因：' + error.message + '\n修复：使用 JSON 参数数组。', true); return; }
  await invoke('tool:save', { id: $('tool-id').value || undefined, name: $('tool-name').value.trim(), description: $('tool-description').value.trim(), command, image: $('tool-image').value.trim() || undefined, enabled: $('tool-enabled').checked }, event.currentTarget.querySelector('[type=submit]'));
  $('tool-dialog').close(); await refresh(); notice('工具已保存。');
}));
$('tool-run-form').addEventListener('submit', guarded(async event => {
  event.preventDefault(); let args;
  try { args = commandArray($('tool-args').value, true); } catch (error) { notice('位置：工具参数\n原因：' + error.message + '\n修复：无附加参数时填写 []。', true); return; }
  $('tool-result').textContent = '容器执行中…';
  if (state.settings.testExecution !== 'docker' && !window.confirm('此工具将在本机项目副本执行，使用当前用户权限。确认运行？')) return;
  try { const result = await invoke('tool:run', { id: runningToolId, args }, $('run-tool')); $('tool-result').textContent = (result.toolName || '') + ' · exit ' + result.exitCode + '\n' + (result.stdout || '') + '\n' + (result.stderr || ''); }
  catch { $('tool-result').textContent = '执行失败；查看错误信息后重试。'; }
}));

for (const [id, title, symbol] of tabs) $('navigation').append(button('', () => navigate(id), `nav-button${id === activeTab ? ' active' : ''}`, { 'data-tab': id, ...(id === activeTab ? { 'aria-current': 'page' } : {}) }));
[...$('navigation').children].forEach((node, index) => node.replaceChildren(el('span', { class: 'nav-symbol', 'aria-hidden': 'true' }, tabs[index][2]), tabs[index][1]));
$('import-project').addEventListener('click', guarded(importProject));
$('rescan-project').addEventListener('click', guarded(async event => { const result = await invoke('project:rescan', undefined, event.currentTarget); state.project = result; render(); notice('项目索引已更新。'); }));
$('close-dialog').addEventListener('click', () => $('skill-dialog').close());
$('save-skill').addEventListener('click', guarded(async event => { await invoke('skill:updateContent', { id: editingSkill, content: $('skill-content').value }, event.currentTarget); $('skill-dialog').close(); await refresh(); notice('Skill 副本已保存。'); }));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('overview'); });
if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', darkMode: true, themeVariables: { background: '#0a0a0a', primaryColor: '#102010', primaryTextColor: '#33ff00', primaryBorderColor: '#1f521f', secondaryColor: '#17210e', tertiaryColor: '#0a0a0a', lineColor: '#33ff00', textColor: '#33ff00', edgeLabelBackground: '#0a0a0a', clusterBkg: '#0a0a0a', clusterBorder: '#1f521f', fontFamily: 'JetBrains Mono, Fira Code, Consolas, Microsoft YaHei, monospace', fontSize: '12px' }, flowchart: { htmlLabels: false, useMaxWidth: true } });
function updateTraceTimers() {
  for (const node of document.querySelectorAll('.trace-duration[data-started-at]')) {
    const seconds = Math.max(0, Math.floor((Date.now()-Date.parse(node.dataset.startedAt))/1000));
    if (Number.isFinite(seconds)) node.textContent = `等待 ${seconds}s${node.dataset.timeoutSeconds ? ' / 上限 '+node.dataset.timeoutSeconds+'s' : ''}`;
  }
}
updateHeaderClock();
clockTimer = setInterval(() => { updateHeaderClock(); updateTraceTimers(); }, 1000);
window.addEventListener('beforeunload', () => clearInterval(clockTimer), { once: true });
if (window.audit) {
  const cleanup = window.audit.onTask(upsertTask);
  pollTelemetry();
  window.addEventListener('beforeunload', () => { cleanup?.(); telemetryStopped = true; clearTimeout(telemetryTimer); }, { once: true });
  refresh().catch(() => { $('main').replaceChildren(empty('工作台读取失败', '查看右下角错误信息，然后重试。', button('重新加载', guarded(refresh), 'primary'))); $('connection-status').textContent = '读取失败'; });
} else {
  $('main').replaceChildren(empty('请从桌面应用启动', '当前页面没有连接本地桌面服务。请使用 Audit Desk 的启动入口打开。'));
  $('connection-status').textContent = '桌面桥接未连接';
}



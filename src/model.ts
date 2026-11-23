import type { ModelSettings } from './contracts';

export const defaults: ModelSettings = {
  protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', timeoutSeconds: 120,
  maxInputChars: 48000, maxOutputTokens: 4096, concurrency: 2, tokenBudget: 200000,
  containerImage: 'node:22-bookworm-slim', contextWindowTokens: 32768, testExecution: 'local',thinkingMode:'disabled'
};

export function validateSettings(input: Partial<ModelSettings>): ModelSettings {
  const s = { ...defaults, ...input };
  s.thinkingMode ||= 'disabled';
  if(!['disabled','enabled','auto'].includes(s.thinkingMode))throw new Error('不支持的 DeepSeek 思考模式');
  if (!['openai', 'anthropic'].includes(s.protocol)) throw new Error('不支持的模型协议');
  if (!['local', 'docker'].includes(s.testExecution!)) throw new Error('测试执行方式必须是 local 或 docker');
  const url = new URL(s.baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)))
    throw new Error('模型地址须使用 HTTPS；本机 localhost 可使用 HTTP，且地址不能包含凭据或查询参数');
  s.baseUrl = url.toString().replace(/\/$/, '');
  if (typeof s.model !== 'string' || s.model.length > 256 || /[\r\n\x00]/.test(s.model)) throw new Error('模型名称无效');
  for (const [key, min, max] of [
    ['timeoutSeconds', 5, 1800], ['maxInputChars', 1000, 6000000], ['maxOutputTokens', 128, 32000],
    ['concurrency', 1, 8], ['tokenBudget', 1000, 5000000], ['contextWindowTokens', 1024, 2000000]
  ] as const) {
    if (!Number.isInteger(s[key]) || s[key]! < min || s[key]! > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
  }
  if (s.apiKey !== undefined && (typeof s.apiKey !== 'string' || s.apiKey.length > 16000 || /[\r\n\x00]/.test(s.apiKey))) throw new Error('API Key 无效');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,255}$/.test(s.containerImage)) throw new Error('容器镜像名称无效');
  if (s.ocrPath && (typeof s.ocrPath !== 'string' || /[\r\n\x00]/.test(s.ocrPath))) throw new Error('OCR 路径无效');
  return s;
}

export function endpoint(s: ModelSettings): string {
  const base = s.baseUrl.replace(/\/$/, '');
  if (s.protocol === 'anthropic') return /\/messages$/.test(base) ? base : base + (/\/v1$/.test(base) ? '/messages' : '/v1/messages');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

export function redact(value: string, key?: string): string {
  let text = value;
  if (key) text = text.split(key).join('[REDACTED]');
  return text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{8,})/g, '[REDACTED]');
}

export type ModelUsage = { inputTokens: number; outputTokens: number; estimated: boolean };
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
export function parseModelJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  try { return JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { throw new Error('模型输出不是完整 JSON；请提高最大输出 token 或使用支持结构化输出的模型'); }
}
export async function retryModelTimeout<T>(operation:(attempt:number)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  for(let attempt=0;;attempt++){
    if(signal?.aborted)throw signal.reason||new Error('任务已取消');
    try{return await operation(attempt);}catch(error:any){
      if(signal?.aborted||error?.code!=='MODEL_TIMEOUT')throw error;
      if(attempt===2)throw Object.assign(new Error(`${error.message} 已自动重试 2 次仍超时，本次任务停止；已完成证据保留。`),{code:'MODEL_TIMEOUT'});
    }
  }
}
export async function callModel(settings: ModelSettings, system: string, prompt: string, signal?: AbortSignal, onUsage?: (usage: ModelUsage) => void,request?:{json?:boolean}): Promise<string> {
  const s = validateSettings(settings);
  if (!s.model.trim()) throw new Error('请先在模型设置中填写模型名称并保存');
  if (system.length + prompt.length > s.maxInputChars) throw new Error('模型输入超过上下文预算，请缩小范围或提高输入上限');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (s.protocol === 'anthropic') { headers['x-api-key'] = s.apiKey || 'local'; headers['anthropic-version'] = '2023-06-01'; }
  else if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
  const body = s.protocol === 'anthropic'
    ? { model: s.model, system, messages: [{ role: 'user', content: prompt }], max_tokens: s.maxOutputTokens }
    : { model: s.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: s.maxOutputTokens, stream: false,...(new URL(s.baseUrl).hostname==='api.deepseek.com'&&/^(deepseek-flash|deepseek-v4-pro|deepseek-v4-flash)$/.test(s.model)&&s.thinkingMode!=='auto'?{thinking:{type:s.thinkingMode}}:{}),...(request?.json&&new URL(s.baseUrl).hostname==='api.deepseek.com'?{response_format:{type:'json_object'}}:{}) };
  const timeout = AbortSignal.timeout(s.timeoutSeconds * 1000);
  let response: Response;
  let raw = '';
  try {
    response = await fetch(endpoint(s), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const reader = response.body?.getReader();
    let size = 0;
    if (reader) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('模型响应超过 4MB 上限'); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally { reader.releaseLock(); }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw Object.assign(new Error(`模型请求超过 ${s.timeoutSeconds} 秒仍未完整返回；本次请求已终止。请检查模型服务，或调整“调用超时”后重新运行。`), {code:'MODEL_TIMEOUT'});
    if (error instanceof TypeError) throw Object.assign(new Error(`无法完成模型连接：${redact(error.message, s.apiKey)}`), {code:'MODEL_NETWORK'});
    throw error;
  }
  if (!response.ok) throw Object.assign(new Error(`模型服务 HTTP ${response.status}：${redact(raw.slice(0, 400), s.apiKey)}`), {code:'MODEL_HTTP'});
  let data: any;
  try { data = JSON.parse(raw); } catch { throw Object.assign(new Error('模型返回的内容不是 JSON API 响应，请检查 Base URL 和协议'), {code:'MODEL_INVALID_API'}); }
  const content = s.protocol === 'anthropic'
    ? data.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n')
    : data.choices?.[0]?.message?.content;
  const inputTokens = data.usage?.prompt_tokens ?? data.usage?.input_tokens;
  const outputTokens = data.usage?.completion_tokens ?? data.usage?.output_tokens;
  const actual = Number.isFinite(inputTokens) && Number.isFinite(outputTokens) && inputTokens >= 0 && outputTokens >= 0;
  const cacheRead = Number(data.usage?.cache_read_input_tokens || 0);
  const cacheWrite = Number(data.usage?.cache_creation_input_tokens || 0);
  if (actual || typeof content === 'string') onUsage?.({inputTokens: actual ? inputTokens + (s.protocol === 'anthropic' ? cacheRead + cacheWrite : 0) : estimateTokens(system + prompt), outputTokens: actual ? outputTokens : estimateTokens(content), estimated: !actual});
  if (data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens') throw Object.assign(new Error(`模型输出达到本次请求上限 ${s.maxOutputTokens} token，被截断；修改并保存后从下一次请求生效`), {code:'MODEL_TRUNCATED'});
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('模型没有返回有效文本；如为推理模型，请提高最大输出 token 并确认协议支持'), {code:'MODEL_EMPTY_RESPONSE'});
  return redact(content, s.apiKey);
}

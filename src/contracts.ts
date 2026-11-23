export type FileRecord = { path: string; size: number; hash?: string; language?: string; status: 'read' | 'skipped' | 'failed'; reason?: string; content?: string };
export type ProjectSnapshot = { id: string; root: string; name: string; indexedAt: string; files: FileRecord[]; modules: string[]; languages: Record<string, number>; diagram: string; warnings: string[] };
export type ModelSettings = { protocol: 'openai' | 'anthropic'; baseUrl: string; model: string; apiKey?: string; timeoutSeconds: number; maxInputChars: number; maxOutputTokens: number; concurrency: number; tokenBudget: number; contextWindowTokens?: number; ocrPath?: string; containerImage: string; testExecution?: 'local' | 'docker'; thinkingMode?:'disabled'|'enabled'|'auto' };
export type SkillRecord = { id: string; name: string; description: string; enabled: boolean; path: string; source: string; sha?: string; hash: string; license?: string; stars?: number; installedAt: string; warnings: string[] };
export type RunInput = { kind: 'audit' | 'test'; engine?: 'security-audit' | 'ocr'; scopes: string[]; skillIds: string[]; toolIds?: string[]; contextBinding?: {projectId:string;contextId:string;generation:number}; resumeFromTaskId?:string; testType?: 'unit' | 'functional' | 'automation' | 'performance'; command?: string[]; objective?: string; generate?: boolean; autoRepair?:boolean; durationSeconds?: number; concurrency?: number; thresholdMs?: number };
export type Finding = { path: string; line: number; title: string; detail: string; status: 'confirmed' | 'needs_validation' | 'rejected' | 'candidate'; severity?: string; evidence?: string; recommendation?: string; engine?: string; rootCause?: string; impact?: string; chainAnalysis?: string; validationPlan?: string; trace?: {kind:string;file:string;line:number;scope?:string;description:string;excerpt:string}[]; dependencies?: {name:string;kind:string;version?:string;file:string;line:number;relationship:string;evidence:string}[] };
export type TaskRecord = { id: string; kind: string; title: string; status: 'queued' | 'running' | 'passed' | 'failed' | 'partial' | 'cancelled' | 'blocked'; createdAt: string; finishedAt?: string; projectName: string; projectId: string; input: RunInput; logs: string[]; findings: Finding[]; coverage: { total: number; reviewed: number; skipped: number }; reportDir: string; summary?: string; metrics?: Record<string, unknown>; diagram?: string; skillVersions?: { id: string; hash: string }[] };
export type ModelCall = (system: string, prompt: string, signal?: AbortSignal,request?:{maxOutputTokens?:number;json?:boolean}) => Promise<string>;
export type EngineOptions = {
  dataDir:string; settings:()=>ModelSettings; modelCall:ModelCall;
  skillInstructions:(ids:string[])=>Promise<string>;
  skillVersions:(ids:string[])=>Promise<{id:string;hash:string}[]>;
  ocr:(args:string[],cwd:string,signal:AbortSignal,onLog:(line:string)=>void)=>Promise<{code:number;stdout:string;stderr:string}>;
  emit:(task:TaskRecord)=>void;
  recordExternalUsage?:(taskId:string,usage:{inputTokens:number;outputTokens:number;estimated:boolean})=>Promise<void>;
  customToolCatalog?:(ids:string[])=>Promise<{id:string;name:string;description:string;command:string[];image?:string}[]>;
  executeCustomTool?:(id:string,args:string[],project:ProjectSnapshot,signal:AbortSignal)=>Promise<{toolName:string;exitCode:number;stdout:string;stderr:string;durationMs:number;reportDir:string}>;
};

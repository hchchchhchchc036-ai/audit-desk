import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ignore from 'ignore';
import { FileRecord, ProjectSnapshot } from './contracts';

const languages: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.py': 'Python', '.cs': 'C#', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cpp': 'C++', '.c': 'C', '.vue': 'Vue', '.html': 'HTML', '.css': 'CSS', '.json': 'JSON', '.md': 'Markdown', '.yaml': 'YAML', '.yml': 'YAML', '.sh': 'Shell', '.ps1': 'PowerShell', '.rb': 'Ruby', '.php': 'PHP', '.sql': 'SQL' };
const excluded = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', 'node_modules', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.next', 'vendor', 'target']);
const secret = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key|p12|pfx|keystore))$/i;
export async function indexProject(input: string): Promise<ProjectSnapshot> {
  const root = await fs.realpath(input);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Project must be a directory');
  const files: FileRecord[] = []; const warnings: string[] = []; let bytes = 0; let stopped = false; let visited = 0;
  type Rule = { base: string; matcher: ReturnType<typeof ignore> };
  async function walk(directory: string, rules: Rule[]) {
    const relative = path.relative(root, directory).split(path.sep).join('/');
    try {
      const rulePath = path.join(directory, '.gitignore'); const stat = await fs.lstat(rulePath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) rules = [...rules, { base: relative, matcher: ignore().add(await fs.readFile(rulePath, 'utf8')) }];
    } catch { /* No local ignore file. */ }
    let entries;
    try { entries = await fs.opendir(directory); } catch { warnings.push(`Cannot read directory: ${relative || '.'}`); return; }
    for await (const entry of entries) {
      if (files.length >= 20000 || ++visited > 40000) { stopped = true; return; }
      const rel = relative ? `${relative}/${entry.name}` : entry.name; const full = path.join(directory, entry.name);
      let stat;
      try { stat = await fs.lstat(full); } catch { files.push({ path: rel, size: 0, status: 'failed', reason: 'Cannot stat file' }); continue; }
      const reason = stat.isSymbolicLink() ? 'Symbolic links excluded' : excluded.has(entry.name) ? 'Dependency or generated directory excluded' : secret.test(rel) ? 'Credential file excluded' : rules.some(rule => rule.matcher.ignores((rule.base ? rel.slice(rule.base.length + 1) : rel) + (stat.isDirectory() ? '/' : ''))) ? 'Ignored by .gitignore' : undefined;
      if (reason) { files.push({ path: rel, size: stat.size, status: 'skipped', reason }); continue; }
      if (stat.isDirectory()) { await walk(full, rules); if (stopped) return; continue; }
      if (!stat.isFile()) { files.push({ path: rel, size: stat.size, status: 'skipped', reason: 'Not a regular file' }); continue; }
      const file: FileRecord = { path: rel, size: stat.size, status: 'skipped', language: languages[path.extname(rel).toLowerCase()] }; files.push(file);
      const asset=/\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i.test(rel);
      const singleLimit=(asset?16:2)*1024*1024;
      if (stat.size > singleLimit) { file.reason = asset?'Static asset exceeds 16 MB':'File exceeds 2 MB'; continue; }
      if (bytes + stat.size > 40 * 1024 * 1024) { file.reason = 'Project content exceeds 40 MB budget'; continue; }
      try {
        const handle = await fs.open(full, 'r');
        try {
          const opened = await handle.stat();
          if (opened.ino !== stat.ino || opened.dev !== stat.dev || !(await fs.lstat(full)).isFile()) { file.reason = 'File changed during indexing'; continue; }
          const buffer = Buffer.alloc(Math.min(stat.size + 1, singleLimit + 1)); const read = await handle.read(buffer, 0, buffer.length, 0); const data = buffer.subarray(0, read.bytesRead);
          if (data.length > stat.size) { file.reason = 'Binary or changing file excluded'; continue; }
          bytes += data.length;file.hash = createHash('sha256').update(data).digest('hex');
          if(asset||data.includes(0)){file.reason='Binary or changing file excluded';continue;}
          file.content = data.toString('utf8'); file.status = 'read';
        } finally { await handle.close(); }
      } catch { file.status = 'failed'; file.reason = 'Cannot read file'; }
    }
  }
  await walk(root, []);
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (stopped) warnings.push('Index truncated at 20,000 file records or 40,000 directory entries');
  if (files.some(f => f.reason?.includes('40 MB'))) warnings.push('Content budget reached; skipped files are not audited');
  const counts: Record<string, number> = {}; for (const file of files) if (file.status === 'read' && file.language) counts[file.language] = (counts[file.language] || 0) + 1;
  const modules = [...new Set(files.filter(f => f.status === 'read').map(f => f.path.includes('/') ? (f.path.split('/')[0] === '(root)' ? '(root)/' : f.path.split('/')[0]) : '(root)'))];
  const label = (value: string) => value.replace(/[^\p{L}\p{N}_./@ ()-]/gu, '_');
  let diagram = 'flowchart TD\n  project["Project directory"]' + modules.slice(0, 40).map((module, i) => `\n  project --> m${i}["${label(module)}"]`).join('');
  const readable = new Map(files.filter(file => file.status === 'read').map(file => [file.path, file]));
  const nodes = new Map<string, string>(); const edges = new Set<string>();
  const node = (name: string) => { if (!nodes.has(name)) { if (nodes.size >= 40) return undefined; const id = `d${nodes.size}`; nodes.set(name, id); diagram += `\n  ${id}["${label(name)}"]`; } return nodes.get(name); };
  for (const file of readable.values()) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path) || !file.content) continue;
    const imports = file.content.matchAll(/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"\n]+)['"]/g);
    for (const match of imports) {
      const specifier = match[1]; let target: string | undefined;
      if (specifier.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
        target = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'].map(extension => base + extension), base.replace(/\.js$/, '.ts')].find(candidate => readable.has(candidate));
      } else { target = `package: ${specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]}`; }
      if (!target || target === file.path || edges.size >= 80) continue;
      const from = node(file.path); const to = node(target); if (!from || !to) continue;
      const edge = `${from} -->|static import inference| ${to}`; if (!edges.has(edge)) { edges.add(edge); diagram += `\n  ${edge}`; }
    }
  }
  if (nodes.size >= 40 || edges.size >= 80 || modules.length > 40) warnings.push('Architecture diagram capped at 40 dependency nodes and 80 inferred import edges; dynamic relationships are unknown');
  return { id: createHash('sha256').update(root).digest('hex').slice(0, 16), root, name: path.basename(root), indexedAt: new Date().toISOString(), files, modules, languages: counts, diagram, warnings };
}
export function selectFiles(project: ProjectSnapshot, scopes: string[]): FileRecord[] {
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) throw new Error('Scopes must be paths');
  const normalized = scopes.map(scope => {
    if (scope === '(root)') return ':root-files:';
    const value = scope.replace(/\\/g, '/').replace(/\/$/, '');
    if (value === '.' || value === '') return '';
    if (/^[A-Za-z]:|^\//.test(value) || value.split('/').some(part => part === '..' || part === '.' || !part) || value.includes('\0')) throw new Error('Invalid relative scope');
    if (!project.files.some(file => file.path === value || file.path.startsWith(value + '/'))) throw new Error(`Scope does not exist: ${value}`);
    return value;
  });
  return project.files.filter(file => !normalized.length || normalized.some(scope => scope === ':root-files:' ? !file.path.includes('/') : !scope || file.path === scope || file.path.startsWith(scope + '/')));
}

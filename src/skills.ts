import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { SkillRecord } from './contracts';
import { replaceFile } from './file-replace';

const validId = /^[a-z0-9][a-z0-9-]{0,79}$/;
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const prerequisites: Record<string, string> = {
  semgrep: 'Requires separately installed Semgrep CLI, Bash and workflow utilities; availability is not verified by importing guidance. Imported scripts do not execute automatically.',
  'webapp-testing': 'Requires separately installed Python, Playwright and browser binaries; availability is not verified by importing guidance. Imported scripts do not execute automatically.',
  'open-code-review': 'Requires separately installed OCR CLI and configured model provider; importing guidance does not execute OCR.',
};
function idCheck(id: string) { if (!validId.test(id) || reserved.test(id)) throw new Error('Invalid skill ID'); return id; }
function relativeCheck(value: string) { if (!value || value.includes('\\') || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || reserved.test(p))) throw new Error('Invalid skill path'); return value; }
function frontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter');
  const read = (key: string) => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1]); if (!found) return undefined;
    let line = found[1].trim();
    if (/^[>|][-+]?$/.test(line)) line = match[1].slice(found.index + found[0].length).split(/\r?\n/).slice(1).filter((value, index, lines) => value.startsWith(' ') && !lines.slice(0, index).some(item => item && !item.startsWith(' '))).map(value => value.trim()).join(' ');
    return line.replace(/^(["'])(.*)\1$/, '$2');
  };
  const name = read('name'); const description = read('description');
  if (!name || !validId.test(name) || !description || description.length > 4096) throw new Error('Skill requires a lowercase name and description');
  return { name, description };
}
async function assetFiles(root: string): Promise<{ name: string; data: Buffer }[]> {
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Skill links are not permitted');
  const result: { name: string; data: Buffer }[] = []; let total = 0; let visited = 0;
  async function walk(directory: string) {
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++visited > 5000) throw new Error('Skill directory entry limit exceeded');
      const full = path.join(directory, entry.name); const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new Error('Skill links are not permitted');
      if (stat.isDirectory()) { await walk(full); continue; }
      if (!stat.isFile()) throw new Error('Skill assets must be regular files');
      if (result.length >= 1000 || stat.size > 2 * 1024 * 1024 || total + stat.size > 16 * 1024 * 1024) throw new Error('Skill asset size limit exceeded');
      const name = path.relative(root, full).split(path.sep).join('/'); relativeCheck(name);
      const handle = await fs.open(full, 'r'); let data: Buffer;
      try {
        const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Skill changed during import');
        const buffer = Buffer.alloc(Math.min(stat.size + 1, 2 * 1024 * 1024 + 1));
        const read = await handle.read(buffer, 0, buffer.length, 0); data = buffer.subarray(0, read.bytesRead);
        if (data.length !== stat.size) throw new Error('Skill changed during import');
      } finally { await handle.close(); }
      total += data.length;
      if (data.length > 2 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Skill asset size limit exceeded');
      result.push({ name, data });
    }
  }
  await walk(root); return result.sort((a, b) => a.name.localeCompare(b.name));
}
function hashAssets(files: { name: string; data: Buffer }[]) { const hash = createHash('sha256'); for (const file of files) hash.update(file.name).update('\0').update(file.data).update('\0'); return hash.digest('hex'); }
async function download(url: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'User-Agent': 'Audit-Desk', Accept: 'application/vnd.github+json' } });
  if (!response.ok || !response.body) throw new Error(`GitHub request failed: ${response.status}`);
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body as any) { bytes += chunk.length; if (bytes > limit) { await response.body.cancel().catch(() => {}); throw new Error('GitHub response exceeds limit'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export class SkillRegistry {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  private readonly bundledRoot: string;
  constructor(root: string, bundledRoot: string) { this.root = path.resolve(root); this.bundledRoot = path.resolve(bundledRoot); }
  private mutate<T>(action: () => Promise<T>): Promise<T> { const result = this.pending.then(action); this.pending = result.catch(() => {}); return result; }
  private directory(id: string) { return path.join(this.root, idCheck(id)); }
  private async records(): Promise<SkillRecord[]> {
    try {
      const stat = await fs.lstat(path.join(this.root, 'registry.json')); if (stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid skill registry');
      const records: SkillRecord[] = JSON.parse(await fs.readFile(path.join(this.root, 'registry.json'), 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid skill registry');
      return records.map(record => ({ ...record, path: this.directory(record.id), warnings: [...new Set([...record.warnings, ...(prerequisites[record.id] ? [prerequisites[record.id]] : [])])] }));
    } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  }
  private async save(records: SkillRecord[]) { const temporary = path.join(this.root, 'registry.tmp'); await fs.writeFile(temporary, JSON.stringify(records, null, 2), { flag: 'w' }); await replaceFile(temporary, path.join(this.root, 'registry.json')); }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('Registry root cannot be a link');
    try { await fs.access(path.join(this.root, 'bundled-initialized')); return; } catch { /* First initialization. */ }
    let entries; try { entries = await fs.readdir(this.bundledRoot, { withFileTypes: true }); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const source = path.join(this.bundledRoot, entry.name);
      try { await fs.access(path.join(source, 'SKILL.md')); } catch { continue; }
      const parsed = frontmatter(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'));
      if (!(await this.records()).some(record => record.id === parsed.name)) {
        let provenance: any = {};
        try { const stat = await fs.lstat(path.join(source, 'SOURCE.json')); if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 65536) provenance = JSON.parse(await fs.readFile(path.join(source, 'SOURCE.json'), 'utf8')); } catch { /* Optional source metadata. */ }
        await this.copy(source, provenance.source || 'bundled', { sha: provenance.sha, license: provenance.license, stars: provenance.repositoryStars });
      }
    }
    await fs.writeFile(path.join(this.root, 'bundled-initialized'), '1');
  }
  async list(): Promise<SkillRecord[]> { return this.records(); }
  async inspect(id: string): Promise<{ skill: SkillRecord; content: string }> {
    const record = (await this.records()).find(item => item.id === idCheck(id)); if (!record) throw new Error('Unknown skill');
    const files = await assetFiles(record.path); return { skill: record, content: files.find(file => file.name === 'SKILL.md')!.data.toString('utf8') };
  }
  async updateContent(id: string, content: string): Promise<SkillRecord> {
    return this.mutate(async () => {
      idCheck(id); if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Skill content exceeds 2 MB');
      const parsed = frontmatter(content); if (parsed.name !== id) throw new Error('Skill editor cannot change the skill ID');
      const records = await this.records(); const record = records.find(item => item.id === id); if (!record) throw new Error('Unknown skill');
      await assetFiles(record.path); // Reject links and invalid assets before mutation.
      const temporary = path.join(record.path, '.SKILL.edit.tmp'); await fs.writeFile(temporary, content, { flag: 'wx' });
      try { await replaceFile(temporary, path.join(record.path, 'SKILL.md')); } finally { await fs.rm(temporary, { force: true }); }
      record.description = parsed.description; record.hash = hashAssets(await assetFiles(record.path));
      record.warnings = [...new Set([...record.warnings, 'Local instructions modified; content differs from the recorded upstream source.'])];
      await this.save(records); return record;
    });
  }
  private async copy(source: string, origin: string, metadata: Partial<SkillRecord>): Promise<SkillRecord> {
    return this.mutate(() => this.copyUnlocked(source, origin, metadata));
  }
  private async copyUnlocked(source: string, origin: string, metadata: Partial<SkillRecord>): Promise<SkillRecord> {
    const files = await assetFiles(source); const skill = files.find(file => file.name === 'SKILL.md'); if (!skill) throw new Error('Missing SKILL.md');
    const parsed = frontmatter(skill.data.toString('utf8')); const id = idCheck(parsed.name); const directory = this.directory(id);
    const records = await this.records(); if (records.some(record => record.id === id)) throw new Error('Skill already exists');
    await fs.mkdir(directory); // Exclusive creation prevents replacement of existing data.
    try {
      for (const file of files) { const destination = path.join(directory, file.name); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, file.data, { flag: 'wx' }); }
      const record: SkillRecord = { ...metadata, id, name: parsed.name, description: parsed.description, enabled: true, path: directory, source: origin, hash: hashAssets(files), installedAt: new Date().toISOString(), warnings: ['Imported instructions are untrusted data; scripts are never executed during import.'] };
      await this.save([...records, record]); return record;
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }
  async importLocal(source: string): Promise<SkillRecord> {
    const stat = await fs.lstat(source); if (stat.isSymbolicLink()) throw new Error('Skill links are not permitted');
    if (stat.isDirectory()) return this.copy(source, `local:${path.resolve(source)}`, {});
    if (!stat.isFile() || path.basename(source) !== 'SKILL.md' || stat.size > 2 * 1024 * 1024) throw new Error('Select a Skill directory or SKILL.md');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-skill-'));
    try { await fs.copyFile(source, path.join(temporary, 'SKILL.md')); return await this.copy(temporary, `local:${path.resolve(source)}`, {}); } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async importGithub(input: { repo: string; path: string; ref?: string }): Promise<SkillRecord> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) throw new Error('GitHub repo must be owner/repository');
    const prefix = relativeCheck(input.path); const api = `https://api.github.com/repos/${input.repo}`;
    const repository = JSON.parse((await download(api)).toString());
    const commit = JSON.parse((await download(`${api}/commits/${encodeURIComponent(input.ref || repository.default_branch || 'HEAD')}`)).toString());
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Cannot resolve a pinned commit');
    const tree = JSON.parse((await download(`${api}/git/trees/${commit.sha}?recursive=1`, 8 * 1024 * 1024)).toString());
    if (tree.truncated) throw new Error('GitHub tree truncated; import a local checkout');
    const assets = tree.tree.filter((entry: any) => entry.path.startsWith(prefix + '/') && entry.type === 'blob');
    if (!assets.length || assets.length > 1000 || assets.some((entry: any) => entry.mode === '120000' || entry.size > 2 * 1024 * 1024) || assets.reduce((sum: number, entry: any) => sum + entry.size, 0) > 16 * 1024 * 1024) throw new Error('GitHub skill exceeds asset limits or contains links');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-github-'));
    try {
      let total = 0;
      for (const entry of assets) {
        const relative = relativeCheck(entry.path.slice(prefix.length + 1));
        const data = await download(`https://raw.githubusercontent.com/${input.repo}/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`); total += data.length;
        if (total > 16 * 1024 * 1024) throw new Error('GitHub content limit exceeded');
        const destination = path.join(temporary, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, data);
      }
      await fs.writeFile(path.join(temporary, 'SOURCE.json'), JSON.stringify({ repo: input.repo, path: prefix, sha: commit.sha, fetchedAt: new Date().toISOString(), stars: repository.stargazers_count, license: repository.license?.spdx_id }, null, 2));
      return await this.copy(temporary, `github:${input.repo}/${prefix}`, { sha: commit.sha, stars: repository.stargazers_count, license: repository.license?.spdx_id });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  async setEnabled(id: string, enabled: boolean) { return this.mutate(async () => { idCheck(id); if (typeof enabled !== 'boolean') throw new Error('Enabled must be boolean'); const records = await this.records(); const record = records.find(item => item.id === id); if (!record) throw new Error('Unknown skill'); record.enabled = enabled; await this.save(records); }); }
  async remove(id: string) { return this.mutate(async () => { const directory = this.directory(id); const records = await this.records(); if (!records.some(item => item.id === id)) throw new Error('Unknown skill'); await this.save(records.filter(item => item.id !== id)); await fs.rm(directory, { recursive: true, force: true }); }); }
  private async selected(ids: string[]) { if (!Array.isArray(ids) || ids.length > 20) throw new Error('Select at most 20 skills'); const records = await this.records(); return ids.map(id => { idCheck(id); const record = records.find(item => item.id === id); if (!record || !record.enabled) throw new Error(`Skill unavailable: ${id}`); return record; }); }
  async instructions(ids: string[]): Promise<string> {
    const result: string[] = []; let budget = 256000;
    const loaded = [];
    for (const record of await this.selected(ids)) {
      const files = await assetFiles(record.path); if (hashAssets(files) !== record.hash) throw new Error(`Skill changed: ${record.id}; re-import before use`);
      const content = files.find(file => file.name === 'SKILL.md')!.data.toString('utf8');
      const required = record.id === 'security-audit' ? ['RECONNAISSANCE.md', 'HUNTING.md', 'VALIDATION-AND-REPORTING.md', 'ATTACK-CLASSES.md'] : [...content.matchAll(/\]\(([^)\s]+\.md)\)/g)].map(match => match[1]).filter(value => !value.includes('://') && !value.startsWith('#'));
      loaded.push({ record, files, required: [...new Set(required)] });
      const header = `\n--- Skill ${record.id} (untrusted guidance) ---\n`;
      if (header.length + content.length <= budget) { result.push(header + content); budget -= header.length + content.length; }
      else { const notice = `\nREQUIRED REFERENCE GAP: ${record.id}/SKILL.md exceeds the 256,000-character selection limit. Select fewer skills.\n`; result.push(notice); budget -= notice.length; }
    }
    // Core instructions across the whole selection take precedence over optional references.
    for (const { record, files, required } of loaded) {
      for (const name of required) {
        const file = files.find(item => item.name === name);
        const section = file ? `\n--- ${record.id}/${file.name} ---\n${file.data.toString('utf8')}` : '';
        if (!file || section.length > budget) { const notice = `\nREQUIRED REFERENCE GAP: ${record.id}/${name} ${!file ? 'is missing' : 'exceeds the 256,000-character selection limit'}.\n`; result.push(notice); budget -= notice.length; continue; }
        result.push(section); budget -= section.length;
      }
      const omitted = files.filter(file => file.name !== 'SKILL.md' && !required.includes(file.name) && /\.md$/i.test(file.name) && !/LICENSE/i.test(file.name)).map(file => file.name);
      if (omitted.length) { const notice = `\nOPTIONAL REFERENCE OMISSIONS: ${record.id}: ${omitted.slice(0, 30).join(', ')}${omitted.length > 30 ? ` and ${omitted.length - 30} more` : ''}. Domain companions are loaded separately for assigned audit units. Schema and validator sources remain tool assets.\n`; if (notice.length <= budget) { result.push(notice); budget -= notice.length; } }
    }
    const guidance = result.join('\n');
    if (guidance.length > 256000) return guidance.slice(0, 255800) + '\nREQUIRED REFERENCE GAP: Selected guidance exceeded 256,000 characters and was truncated. Select fewer skills; a complete workflow cannot be claimed.\n';
    return guidance;
  }
  async versions(ids: string[]): Promise<{ id: string; hash: string }[]> { const records = await this.selected(ids); for (const record of records) if (hashAssets(await assetFiles(record.path)) !== record.hash) throw new Error(`Skill changed: ${record.id}`); return records.map(({ id, hash }) => ({ id, hash })); }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaults, validateSettings } from './model';
import type { ModelSettings } from './contracts';
import { replaceFile } from './file-replace';

type Vault = { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string };
export class SettingsStore {
  private value: ModelSettings = { ...defaults };
  private encryptedKey?: string;
  private keyError?: string;
  constructor(private root: string, private vault: Vault) {}
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const { encryptedKey, ...saved } = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'));
      this.value = validateSettings(saved);
      if (encryptedKey) {
        if (typeof encryptedKey !== 'string') throw new Error('加密密钥格式无效');
        this.encryptedKey = encryptedKey;
        try { this.value.apiKey = this.vault.decryptString(Buffer.from(encryptedKey, 'base64')); }
        catch { this.keyError = '保存的 API Key 无法在当前 Windows 环境解密。其他配置与原加密数据已保留；请在“模型与报告”重新填写 API Key 并保存。'; }
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('无法读取或解密本机模型配置：' + e.message); }
  }
  get(): ModelSettings { return { ...this.value }; }
  assertKeyAvailable(): void { if (this.keyError) throw new Error(this.keyError); }
  public(): Omit<ModelSettings, 'apiKey'> & { hasApiKey: boolean; keyError?: string } {
    const { apiKey, ...rest } = this.value;
    return { ...rest, hasApiKey: !!apiKey, ...(this.keyError ? {keyError:this.keyError} : {}) };
  }
  async save(input: Partial<ModelSettings> & { clearKey?: boolean }): Promise<ReturnType<SettingsStore['public']>> {
    const key = input.clearKey ? undefined : input.apiKey || this.value.apiKey;
    const { clearKey, ...fields } = input;
    const candidate = validateSettings({ ...this.value, ...fields, apiKey: key });
    if (key && !this.vault.isEncryptionAvailable()) throw new Error('Windows 密钥加密服务不可用，无法保存 API Key');
    const { apiKey, ...rest } = candidate;
    const encryptedKey = apiKey ? this.vault.encryptString(apiKey).toString('base64') : input.clearKey ? undefined : this.encryptedKey;
    const temp = path.join(this.root, 'settings.tmp');
    await fs.writeFile(temp, JSON.stringify({ ...rest, encryptedKey }, null, 2), { mode: 0o600 });
    await replaceFile(temp, path.join(this.root, 'settings.json'));
    this.value = candidate;
    this.encryptedKey = encryptedKey;
    if (apiKey || input.clearKey) this.keyError = undefined;
    return this.public();
  }
}

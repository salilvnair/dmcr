/**
 * secret-store — wraps VS Code SecretStorage for LLM API key persistence.
 *
 * Keys are namespaced as "dmcr.llm.<providerId>" to avoid collisions with
 * other extensions. The OS keychain is used on every platform:
 *   macOS  → Keychain Access
 *   Windows → Windows Credential Manager
 *   Linux   → libsecret / GNOME Keyring / KWallet
 */
import * as vscode from 'vscode';
import { findAll, upsert } from '../../../storage/db';

const KEY_PREFIX = 'dmcr.llm';

let _secrets: vscode.SecretStorage | undefined;

export function initSecretStore(secrets: vscode.SecretStorage): void {
  _secrets = secrets;
}

function keyFor(providerId: string): string {
  return `${KEY_PREFIX}.${providerId}`;
}

export async function storeApiKey(providerId: string, token: string): Promise<void> {
  if (!_secrets) throw new Error('SecretStore not initialized — call initSecretStore first');
  await _secrets.store(keyFor(providerId), token);
}

export async function retrieveApiKey(providerId: string): Promise<string | undefined> {
  if (!_secrets) return undefined;
  return _secrets.get(keyFor(providerId));
}

export async function deleteApiKey(providerId: string): Promise<void> {
  if (!_secrets) return;
  await _secrets.delete(keyFor(providerId));
}

/* ── Other settings secrets (MCP server env/headers/args, provider headers) ── */

/** True when the OS keychain is available (secrets go there instead of SQLite). */
export function hasSecretStore(): boolean {
  return !!_secrets;
}

/** Store a JSON value under "dmcr.<name>". Returns false when the keychain is unavailable. */
export async function storeSecretJson(name: string, value: unknown): Promise<boolean> {
  if (!_secrets) return false;
  await _secrets.store(`dmcr.${name}`, JSON.stringify(value));
  return true;
}

export async function retrieveSecretJson<T>(name: string): Promise<T | undefined> {
  if (!_secrets) return undefined;
  const raw = await _secrets.get(`dmcr.${name}`);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export async function deleteSecretJson(name: string): Promise<void> {
  if (!_secrets) return;
  await _secrets.delete(`dmcr.${name}`);
}

/** Returns a map of providerId → hasKey (never exposes actual tokens). */
export async function getAllKeyStatus(providerIds: string[]): Promise<Record<string, boolean>> {
  if (!_secrets) return {};
  const results: Record<string, boolean> = {};
  await Promise.all(
    providerIds.map(async (id) => {
      const val = await _secrets!.get(keyFor(id));
      results[id] = !!val && val.length > 0;
    }),
  );
  return results;
}

/**
 * One-time migration: earlier builds stored apiKey directly in SQLite.
 * Move any such plaintext key to the OS keychain and scrub from the DB record.
 * Safe to call on every activation — no-op once all records are migrated.
 */
export async function migrateLegacyApiKeys(): Promise<void> {
  if (!_secrets) return;
  const providerRecords = findAll<{ key: string; apiKey?: string }>('custom_providers');
  for (const rec of providerRecords) {
    if (rec.apiKey) {
      await storeApiKey(rec.key, rec.apiKey);
      const { apiKey: _k, ...rest } = rec;
      upsert('custom_providers', rec.key, rest);
    }
  }
}

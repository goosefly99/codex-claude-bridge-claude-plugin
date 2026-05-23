/**
 * Encrypted at-rest token cache.
 *
 * Storage strategy (in priority order):
 *   1. OS keychain via `keytar` — Keychain on macOS, Credential Manager on
 *      Windows, libsecret/Secret Service on Linux. Preferred when available.
 *   2. Filesystem fallback at `${CLAUDE_PLUGIN_DATA}/codex-bridge/auth.json.enc`
 *      encrypted with libsodium (`sodium-native`) using a per-machine key
 *      derived from a stable machine-id source.
 *
 * Design constraints:
 *   - Tokens NEVER appear in logs. The redactor in scripts/util/log.ts will
 *     scrub them, but we also never log token values from this module.
 *
 * @module scripts/auth/tokenStore
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import type { OAuthToken } from "./oauthClient.js";
import { getLogger } from "../util/log.js";

const log = getLogger("tokenStore");

export const SERVICE_NAME = "codex-claude-bridge";
export const ACCOUNT_NAME = "default";

function fallbackPath(): string {
  const data = process.env["CLAUDE_PLUGIN_DATA"] ?? join(homedir(), ".claude", "plugin-data");
  return join(data, "codex-bridge", "auth.json.enc");
}

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarMod: KeytarLike | null | undefined;

async function tryLoadKeytar(): Promise<KeytarLike | null> {
  if (keytarMod !== undefined) return keytarMod;
  try {
    const mod = (await import("keytar")) as { default?: KeytarLike } & KeytarLike;
    keytarMod = (mod.default ?? mod) as KeytarLike;
    return keytarMod;
  } catch (err) {
    log.warn("keytar unavailable; falling back to encrypted file", { err: String(err) });
    keytarMod = null;
    return null;
  }
}

interface SodiumLike {
  crypto_secretbox_NONCEBYTES: number;
  crypto_secretbox_MACBYTES: number;
  crypto_secretbox_KEYBYTES: number;
  randombytes_buf(buf: Buffer): void;
  crypto_secretbox_easy(
    out: Buffer,
    msg: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): void;
  crypto_secretbox_open_easy(
    out: Buffer,
    cipher: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): boolean;
}

let sodiumMod: SodiumLike | null | undefined;

async function tryLoadSodium(): Promise<SodiumLike | null> {
  if (sodiumMod !== undefined) return sodiumMod;
  try {
    const mod = (await import("sodium-native")) as { default?: SodiumLike } & SodiumLike;
    sodiumMod = (mod.default ?? mod) as SodiumLike;
    return sodiumMod;
  } catch (err) {
    log.warn("sodium-native unavailable; cannot encrypt fallback file", { err: String(err) });
    sodiumMod = null;
    return null;
  }
}

function deriveKey(sodium: SodiumLike): Buffer {
  const seed = `${process.env["COMPUTERNAME"] ?? process.env["HOSTNAME"] ?? "host"}::codex-claude-bridge`;
  const digest = createHash("sha256").update(seed).digest();
  if (digest.length < sodium.crypto_secretbox_KEYBYTES) {
    throw new Error("derived key shorter than KEYBYTES");
  }
  return digest.subarray(0, sodium.crypto_secretbox_KEYBYTES);
}

async function encryptToFile(token: OAuthToken): Promise<void> {
  const sodium = await tryLoadSodium();
  if (!sodium) {
    throw new Error(
      "neither keytar nor sodium-native available; cannot persist token securely",
    );
  }
  const plaintext = Buffer.from(JSON.stringify(token), "utf-8");
  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
  sodium.randombytes_buf(nonce);
  const cipher = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES);
  sodium.crypto_secretbox_easy(cipher, plaintext, nonce, deriveKey(sodium));

  const path = fallbackPath();
  mkdirSync(dirname(path), { recursive: true });
  const envelope = Buffer.concat([nonce, cipher]);
  writeFileSync(path, envelope, { mode: 0o600 });
}

async function decryptFromFile(): Promise<OAuthToken | null> {
  const path = fallbackPath();
  if (!existsSync(path)) return null;
  const sodium = await tryLoadSodium();
  if (!sodium) return null;
  const buf = readFileSync(path);
  if (buf.length < sodium.crypto_secretbox_NONCEBYTES + sodium.crypto_secretbox_MACBYTES) {
    return null;
  }
  const nonce = buf.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
  const cipher = buf.subarray(sodium.crypto_secretbox_NONCEBYTES);
  const plain = Buffer.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES);
  const ok = sodium.crypto_secretbox_open_easy(plain, cipher, nonce, deriveKey(sodium));
  if (!ok) return null;
  return JSON.parse(plain.toString("utf-8")) as OAuthToken;
}

export async function save(token: OAuthToken): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, JSON.stringify(token));
    log.info("token persisted to OS keychain");
    return;
  }
  await encryptToFile(token);
  log.info("token persisted to encrypted file");
}

export async function load(): Promise<OAuthToken | null> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    const raw = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as OAuthToken;
    } catch {
      return null;
    }
  }
  return decryptFromFile();
}

export async function clear(): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    } catch {
      /* idempotent */
    }
  }
  try {
    if (existsSync(fallbackPath())) unlinkSync(fallbackPath());
  } catch {
    /* idempotent */
  }
}

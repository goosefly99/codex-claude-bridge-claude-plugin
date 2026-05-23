declare module "sodium-native" {
  export const crypto_secretbox_NONCEBYTES: number;
  export const crypto_secretbox_MACBYTES: number;
  export const crypto_secretbox_KEYBYTES: number;
  export function randombytes_buf(buf: Buffer): void;
  export function crypto_secretbox_easy(
    out: Buffer,
    msg: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): void;
  export function crypto_secretbox_open_easy(
    out: Buffer,
    cipher: Buffer,
    nonce: Buffer,
    key: Buffer,
  ): boolean;
}

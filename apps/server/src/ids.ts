import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Rng } from '@unpoker/core';

// 読み間違えやすい文字（0 O 1 I L）を除いた 32 文字
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const newRoomId = (): string =>
  Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');

export const newToken = (): string => randomBytes(24).toString('base64url');

export const newPlayerId = (): string => randomBytes(6).toString('base64url');

/** 暗号論的乱数による Rng（0 以上 1 未満） */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

/** 対局ごとの乱数の種（256 ビット。端末には送らない） */
export const newSeed = (): string => randomBytes(32).toString('hex');

/**
 * 種と操作の番号から決まる乱数（記録から再現するため）。SHA-256 のカウンター方式なので、
 * 見えている札から種や先の札を割り出すことはできない
 */
export function streamRng(seed: string, eventNo: number): Rng {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return () => {
    if (pos + 6 > buf.length) {
      buf = createHash('sha256').update(`${seed}:${eventNo}:${counter++}`).digest();
      pos = 0;
    }
    const v = buf.readUIntBE(pos, 6) / 2 ** 48;
    pos += 6;
    return v;
  };
}

import { randomBytes, randomInt } from 'node:crypto';
import type { Rng } from '@unpoker/core';

// 読み間違えやすい文字（0 O 1 I L）を除いた 32 文字
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const newRoomId = (): string =>
  Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');

export const newToken = (): string => randomBytes(24).toString('base64url');

export const newPlayerId = (): string => randomBytes(6).toString('base64url');

/** 暗号論的乱数による Rng（0 以上 1 未満） */
export const cryptoRng: Rng = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

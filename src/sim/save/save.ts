/**
 * Save games (spec §55). A save is the whole `SimState` as JSON, with typed arrays packed as
 * base64 so a 96×96 map stays small, wrapped in metadata. `migrate` upgrades older saves step by
 * step; add a function to MIGRATIONS whenever SimState changes shape and bump SAVE_VERSION.
 */
import type { SimState } from "../state.js";
import { SAVE_VERSION } from "../scenario.js";

export const GAME_VERSION = "0.1.0";

export interface SaveMetadata {
  saveName: string;
  timestamp: string;
  gameVersion: string;
  saveVersion: number;
  scenarioId: string;
  mineName: string;
  day: number;
  cash: number;
}

export interface SaveGame {
  metadata: SaveMetadata;
  state: unknown;
}

type TypedArray = Float32Array | Uint8Array | Uint32Array;
const TYPED: Record<string, new (buf: ArrayBuffer) => TypedArray> = {
  Float32Array,
  Uint8Array,
  Uint32Array,
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]!);
    const b = B64.indexOf(clean[i + 1] ?? "A");
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : 0;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function pack(value: unknown): unknown {
  if (value instanceof Float32Array || value instanceof Uint8Array || value instanceof Uint32Array) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $typed: value.constructor.name, b64: bytesToBase64(bytes) };
  }
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = pack(v);
    return out;
  }
  return value;
}

function unpack(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.$typed === "string" && typeof v.b64 === "string") {
      const ctor = TYPED[v.$typed];
      if (!ctor) throw new Error(`save: unknown typed array ${v.$typed}`);
      const bytes = base64ToBytes(v.b64);
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      return new ctor(buf);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = unpack(x);
    return out;
  }
  return value;
}

/** saveVersion n → n+1. */
const MIGRATIONS: Record<number, (state: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(state: Record<string, unknown>): SimState {
  let v = Number(state.saveVersion ?? 1);
  while (v < SAVE_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`save: no migration from version ${v}`);
    state = m(state);
    v++;
    state.saveVersion = v;
  }
  if (v > SAVE_VERSION) throw new Error(`save: version ${v} is newer than this game (${SAVE_VERSION})`);
  return state as unknown as SimState;
}

/** `now` is passed in: the simulation layer never reads the wall clock (tools/lint-arch.mjs). */
export function serialize(state: SimState, saveName: string, now: Date): string {
  const metadata: SaveMetadata = {
    saveName,
    timestamp: now.toISOString(),
    gameVersion: GAME_VERSION,
    saveVersion: state.saveVersion,
    scenarioId: state.scenarioId,
    mineName: state.mineName,
    day: Math.floor((state.clock.tick * 5) / 86400) + 1,
    cash: Math.round(state.treasury.cash),
  };
  const save: SaveGame = { metadata, state: pack(state) };
  return JSON.stringify(save);
}

export function deserialize(json: string): { metadata: SaveMetadata; state: SimState } {
  const save = JSON.parse(json) as SaveGame;
  if (!save || typeof save !== "object" || !save.metadata || !save.state) throw new Error("save: not a Black Creek save file");
  const state = migrate(unpack(save.state) as Record<string, unknown>);
  return { metadata: save.metadata, state };
}

/**
 * What the DOM UI may do. The UI reads simulation state freely but changes it only through
 * src/sim/commands.ts (via `sim`), and changes presentation through this interface.
 */
import type { MineSimulation } from "../../sim/simulation.js";
import type { Overlay } from "../terrainView.js";
import type { CameraMode } from "../camera.js";

export type Selection =
  | { kind: "equipment"; id: string }
  | { kind: "block"; id: string }
  | { kind: "worker"; id: string }
  | { kind: "task"; id: string }
  | { kind: "point"; x: number; z: number }
  | null;

export interface GameApi {
  readonly ms: MineSimulation;
  selection: Selection;
  select(s: Selection, focus?: boolean): void;
  setSpeed(speed: number): void;
  speed(): number;
  setOverlay(o: Overlay): void;
  overlay(): Overlay;
  setCameraMode(m: CameraMode): void;
  cameraMode(): CameraMode;
  /** Ask the player to click a point on the map; resolves with world x/z or null when cancelled. */
  pickPoint(prompt: string): Promise<{ x: number; z: number } | null>;
  /** Mark that the selection's highlight point changed. */
  setMarker(p: { x: number; z: number } | null): void;
  save(slot: string): string | null;
  load(slot: string): string | null;
  exportSave(): string;
  importSave(json: string): string | null;
  newGame(seed?: number): void;
  terrainChanged(): void;
  readonly debug: boolean;
  stats(): { fps: number; ticksPerSecond: number; drawCalls: number; chunksPending: number; gpu: string };
}

// Persisted settings for the SSTV QSO Card composer — kept alive across page
// loads via localStorage (small, string-only values; the actual card images
// live in IndexedDB, see qsoCardStore.ts).
import { loadString, saveString, loadObject, saveObject } from '../storage';
import { SSTV_MODES } from './constants';

export type EncodableSSTVMode = keyof typeof SSTV_MODES;

export const ENCODABLE_MODES = Object.keys(SSTV_MODES) as EncodableSSTVMode[];

const LS_MODE = 'sstv_tx_mode';
const LS_TEXT_LAYERS = 'sstv_tx_text_layers';
const LS_REPLY_BOXES = 'sstv_tx_reply_boxes';
const LS_MY_CALL = 'sstv_tx_my_call';

export interface TextLayer {
  id: string;
  text: string;
  x: number; // 0-1 fraction of canvas width
  y: number; // 0-1 fraction of canvas height
  fontSize: number; // px, relative to a 320-wide reference canvas
  fontFamily: string;
  color: string; // CSS color
  strokeColor: string; // outline for legibility over busy backgrounds
}

/** An empty outlined rectangle baked into the transmitted image for a human
 *  recipient to fill in by hand (callsign + signal report) once they've
 *  decoded/printed the card — drawn as a box, not text, since nothing is
 *  known about the replier at compose time. */
export interface ReplyBox {
  id: string;
  label: string; // e.g. "Callsign" / "RST" — printed above/inside the box as a hint
  x: number; // 0-1 fraction of canvas width (top-left corner)
  y: number; // 0-1 fraction of canvas height (top-left corner)
  width: number; // 0-1 fraction of canvas width
  height: number; // 0-1 fraction of canvas height
  color: string; // CSS color for the box outline + label
}

export const COMMON_FONTS = [
  'Arial',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Comic Sans MS',
] as const;

export const DEFAULT_TEXT_LAYER: Omit<TextLayer, 'id'> = {
  text: '',
  x: 0.5,
  y: 0.9,
  fontSize: 24,
  fontFamily: 'Arial',
  color: '#ffffff',
  strokeColor: '#000000',
};

export const REPLY_BOX_PRESETS = ['Callsign', 'RST', 'Name', 'QTH'] as const;

export const DEFAULT_REPLY_BOX: Omit<ReplyBox, 'id'> = {
  label: 'Callsign',
  x: 0.05,
  y: 0.05,
  width: 0.4,
  height: 0.12,
  color: '#ffcc00',
};

export function loadTxMode(): EncodableSSTVMode {
  return loadString<EncodableSSTVMode>(LS_MODE, 'ROBOT36', ENCODABLE_MODES);
}
export function saveTxMode(mode: EncodableSSTVMode): void {
  saveString(LS_MODE, mode);
}

interface TextLayersShape {
  layers: TextLayer[];
}
const DEFAULT_LAYERS: TextLayersShape = { layers: [] };

export function loadTextLayers(): TextLayer[] {
  return loadObject<TextLayersShape>(LS_TEXT_LAYERS, DEFAULT_LAYERS).layers;
}
export function saveTextLayers(layers: TextLayer[]): void {
  saveObject<TextLayersShape>(LS_TEXT_LAYERS, { layers });
}

interface ReplyBoxesShape {
  boxes: ReplyBox[];
}
const DEFAULT_REPLY_BOXES: ReplyBoxesShape = { boxes: [] };

export function loadReplyBoxes(): ReplyBox[] {
  return loadObject<ReplyBoxesShape>(LS_REPLY_BOXES, DEFAULT_REPLY_BOXES).boxes;
}
export function saveReplyBoxes(boxes: ReplyBox[]): void {
  saveObject<ReplyBoxesShape>(LS_REPLY_BOXES, { boxes });
}

// Free-form text (a callsign), not a fixed enum — loadString/saveString
// require a `valid` allowlist, so this reads/writes localStorage directly,
// matching useFTTransmit.ts's loadMyCall/saveMyCall.
export function loadMyCall(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(LS_MY_CALL) ?? '';
}
export function saveMyCall(call: string): void {
  if (typeof window !== 'undefined') localStorage.setItem(LS_MY_CALL, call);
}

import type { RTTYConfig } from './decoder';

export const PASTEL_COLORS = [
  '#88c0a8', // sage
  '#88aed0', // steel blue
  '#d0a888', // peach
  '#c088b8', // mauve
  '#a888d0', // lavender
  '#c8b870', // gold
  '#88c0c8', // teal
  '#d09090', // rose
  '#b0a0e0', // violet
  '#90d0b0', // mint
  '#e0b090', // sandy
  '#90b8e0', // sky
];

export interface DecoderSession {
  id: string;
  label: string;
  color: string;
  config: RTTYConfig;
  preview: string;   // last ~120 chars, newlines replaced with spaces
  fullText: string;
}

export interface SessionsState {
  sessions: DecoderSession[];
  activeSessionId: string;
}

export type SessionsAction =
  | { type: 'ADD_SESSION';    config: RTTYConfig }
  | { type: 'REMOVE_SESSION'; id: string }
  | { type: 'ACTIVATE';       id: string }
  | { type: 'UPDATE_CONFIG';  id: string; patch: Partial<RTTYConfig> }
  | { type: 'APPEND_TEXT';    id: string; chars: string }
  | { type: 'UPDATE_LABEL';   id: string; label: string }
  | { type: 'UPDATE_COLOR';   id: string; color: string }
  | { type: 'CLEAR_TEXT';     id: string };

let _counter = 0;
export function makeSession(config: RTTYConfig): DecoderSession {
  _counter++;
  return {
    id: crypto.randomUUID(),
    label: `Decoder ${_counter}`,
    color: PASTEL_COLORS[(_counter - 1) % PASTEL_COLORS.length],
    config: { ...config },
    preview: '',
    fullText: '',
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function sessionsReducer(state: SessionsState, action: SessionsAction): SessionsState {
  switch (action.type) {
    case 'ADD_SESSION': {
      const s = makeSession(action.config);
      return { ...state, sessions: [...state.sessions, s] };
    }

    case 'REMOVE_SESSION': {
      if (state.sessions.length <= 1) return state;
      const sessions = state.sessions.filter(s => s.id !== action.id);
      const activeSessionId = state.activeSessionId === action.id
        ? sessions[0].id
        : state.activeSessionId;
      return { sessions, activeSessionId };
    }

    case 'ACTIVATE':
      return { ...state, activeSessionId: action.id };

    case 'UPDATE_CONFIG':
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.id === action.id ? { ...s, config: { ...s.config, ...action.patch } } : s
        ),
      };

    case 'APPEND_TEXT':
      return {
        ...state,
        sessions: state.sessions.map(s => {
          if (s.id !== action.id) return s;
          const full = normalizeText(s.fullText + action.chars);
          const lines = full.split('\n').filter(l => l.length > 0);
          const preview = lines.slice(-2).map(l => l.slice(-120)).join('\n');
          return { ...s, fullText: full, preview };
        }),
      };

    case 'UPDATE_LABEL':
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.id === action.id ? { ...s, label: action.label } : s
        ),
      };

    case 'UPDATE_COLOR':
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.id === action.id ? { ...s, color: action.color } : s
        ),
      };

    case 'CLEAR_TEXT':
      return {
        ...state,
        sessions: state.sessions.map(s =>
          s.id === action.id ? { ...s, fullText: '', preview: '' } : s
        ),
      };

    default:
      return state;
  }
}

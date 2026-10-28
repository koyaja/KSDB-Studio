// Thèmes de l'interface et résolution (système, horaire).
import type { Settings, ThemeId } from '../shared/types';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  dark: boolean;
  description: string;
  /** couleurs d'aperçu : fond, panneau, texte, accent */
  preview: [string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'night',
    label: 'Nuit douce',
    dark: true,
    description: 'Sombre aux tons chauds, contraste modéré et peu de bleu. Pour le soir et les pièces peu éclairées.',
    preview: ['#1e1b18', '#26221e', '#e3d9c9', '#d4a256'],
  },
  {
    id: 'paper',
    label: 'Papier',
    dark: false,
    description: 'Clair et chaud, sans blanc pur ni noir pur. Pour la journée dans une pièce bien éclairée.',
    preview: ['#f5f0e6', '#fbf8f1', '#3b342b', '#9a5b13'],
  },
  {
    id: 'dark',
    label: 'Sombre',
    dark: true,
    description: 'Sombre bleuté, contraste plus net.',
    preview: ['#1c2029', '#232834', '#dde2ea', '#7385ff'],
  },
  {
    id: 'light',
    label: 'Clair',
    dark: false,
    description: 'Clair neutre et lumineux.',
    preview: ['#f6f7f9', '#ffffff', '#1d2330', '#3b4fd8'],
  },
];

export const themeInfo = (id: ThemeId) => THEMES.find((t) => t.id === id) ?? THEMES[2];

export const DEFAULT_SCHEDULE: NonNullable<Settings['themeSchedule']> = {
  day: 'paper',
  night: 'night',
  from: '19:00',
  to: '07:00',
};

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Le moment donné est-il dans la plage « nuit » (qui peut passer minuit) ? */
export function isNight(now: Date, from: string, to: string): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const a = minutes(from);
  const b = minutes(to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

export function resolveTheme(s: Settings, systemDark: boolean, now = new Date()): ThemeId {
  if (s.theme === 'system') {
    const sch = s.themeSchedule ?? DEFAULT_SCHEDULE;
    return systemDark ? sch.night : sch.day;
  }
  if (s.theme === 'schedule') {
    const sch = s.themeSchedule ?? DEFAULT_SCHEDULE;
    return isNight(now, sch.from, sch.to) ? sch.night : sch.day;
  }
  return s.theme;
}

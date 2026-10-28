import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { setState, useApp } from '../state';

// ---------- Modale ----------
export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props.onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="btn icon" onClick={props.onClose} aria-label="Fermer">
            <X />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Dialogues confirm / prompt ----------
export function DialogHost() {
  const d = useApp((s) => s.dialog);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (d) {
      setValue(d.defaultValue ?? '');
      setTimeout(() => inputRef.current?.select(), 30);
    }
  }, [d?.id]);
  if (!d) return null;
  const close = (v: string | boolean | null) => {
    setState({ dialog: null });
    d.resolve(v);
  };
  const ok = () => close(d.kind === 'prompt' ? value : true);
  return (
    <Modal
      title={d.title}
      onClose={() => close(d.kind === 'prompt' ? null : false)}
      footer={
        <>
          <button className="btn outline" onClick={() => close(d.kind === 'prompt' ? null : false)}>
            Annuler
          </button>
          <button className={`btn ${d.danger ? 'danger' : 'primary'}`} onClick={ok} autoFocus={d.kind === 'confirm'}>
            {d.confirmLabel ?? (d.kind === 'prompt' ? 'Valider' : 'Confirmer')}
          </button>
        </>
      }
    >
      {d.message && <p>{d.message}</p>}
      {d.kind === 'prompt' && (
        <input
          ref={inputRef}
          className="input"
          style={{ width: '100%' }}
          type={d.password ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ok()}
          autoFocus
        />
      )}
    </Modal>
  );
}

// ---------- Toasts ----------
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? (
            <AlertCircle color="var(--danger)" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 color="var(--ok)" />
          ) : (
            <Info color="var(--accent)" />
          )}
          <div>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- Menu contextuel ----------
export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
}

let menu: { x: number; y: number; items: MenuItem[] } | null = null;
const menuListeners = new Set<() => void>();
export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  menu = { x: e.clientX, y: e.clientY, items };
  menuListeners.forEach((l) => l());
}
function closeMenu() {
  menu = null;
  menuListeners.forEach((l) => l());
}

export function ContextMenuHost() {
  const m = useSyncExternalStore(
    (l) => {
      menuListeners.add(l);
      return () => menuListeners.delete(l);
    },
    () => menu,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(m.x, window.innerWidth - r.width - 6),
      y: Math.min(m.y, window.innerHeight - r.height - 6),
    });
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const close = () => closeMenu();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, [m]);
  if (!m) return null;
  return createPortal(
    <div className="ctxmenu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
      {m.items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.45 } : undefined}
            onClick={() => {
              closeMenu();
              it.onClick?.();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// ---------- Divers ----------
export function Field(props: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={`field ${props.className ?? ''}`}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small className="hint">{props.hint}</small>}
    </label>
  );
}

export function useDrag(onMove: (dx: number, dy: number) => void, onEnd?: () => void) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: MouseEvent) => onMove(ev.clientX - sx, ev.clientY - sy);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      onEnd?.();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export const fmtInt = (n: number) => n.toLocaleString('fr-FR');

export const CONNECTION_COLORS = ['#7385ff', '#5fc48f', '#e3a64a', '#f0716b', '#c27ef2', '#4cc3d9', '#a3abbb'];

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="8" ry="3" fill="none" stroke="var(--accent)" strokeWidth="1.8" />
      <path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" fill="none" stroke="var(--accent)" strokeWidth="1.8" />
      <path d="M4 11.5v6c0 1.66 3.58 3 8 3" fill="none" stroke="var(--text-2)" strokeWidth="1.8" />
      <path d="M15 16.5l2.5 2.5 4-5" fill="none" stroke="var(--ochre)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

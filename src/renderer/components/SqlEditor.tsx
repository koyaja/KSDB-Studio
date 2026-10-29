import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MariaSQL, MySQL, PostgreSQL, sql, SQLNamespace } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { statementAt } from '../../shared/sqlsplit';
import type { DbKind } from '../../shared/types';
import type { Completion } from '../api';

export interface SqlEditorHandle {
  /** Sélection si non vide, sinon instruction sous le curseur. */
  smartText(): { text: string; from: number } | null;
  allText(): string;
  setText(t: string): void;
  replaceRange(from: number, to: number, text: string): void;
  selectionRange(): { from: number; to: number };
  focus(): void;
  insert(text: string): void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  kind: DbKind;
  mariadb?: boolean;
  completion?: Completion | null;
  fontSize: number;
  dark: boolean;
  uppercase: boolean;
  onRun?: (mode: 'smart' | 'all') => void;
  onFormat?: () => void;
  onSave?: () => void;
  onExplain?: () => void;
  onExplainAnalyze?: () => void;
  readOnly?: boolean;
}

/** Coloration pilotée par les variables CSS du thème actif (--syn-*). */
const themedHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: 'var(--syn-kw)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.standard(t.name)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: [t.propertyName, t.special(t.name), t.labelName], color: 'var(--syn-prop)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-op)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none', paddingRight: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-current-stmt': { backgroundColor: 'color-mix(in srgb, var(--panel) 70%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line-strong)', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important', fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
  '.cm-placeholder': { color: 'var(--muted)' },
});

function currentStatementPlugin(getKind: () => DbKind) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const b = new RangeSetBuilder<Decoration>();
        const doc = view.state.doc;
        if (doc.length > 400_000 || !view.state.selection.main.empty) return b.finish();
        const text = doc.toString();
        const stmts = statementAt(text, getKind(), view.state.selection.main.head);
        if (!stmts || text.split(';').length < 2) return b.finish();
        const l0 = doc.lineAt(stmts.start).number;
        const l1 = doc.lineAt(Math.min(stmts.end, doc.length)).number;
        if (l0 === l1 && doc.lines === 1) return b.finish();
        const deco = Decoration.line({ class: 'cm-current-stmt' });
        for (let l = l0; l <= l1; l++) b.add(doc.line(l).from, doc.line(l).from, deco);
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function toNamespace(c: Completion | null | undefined): SQLNamespace | undefined {
  if (!c) return undefined;
  return c.schemas as unknown as SQLNamespace;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const lang = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const font = useRef(new Compartment());
  const ro = useRef(new Compartment());

  const langExt = () =>
    sql({
      dialect: props.kind === 'postgres' ? PostgreSQL : props.mariadb ? MariaSQL : MySQL,
      schema: toNamespace(props.completion),
      defaultSchema: props.completion?.defaultSchema,
      upperCaseKeywords: props.uppercase,
    });
  const themeExt = () => syntaxHighlighting(themedHighlight);
  const fontExt = () => EditorView.theme({ '.cm-scroller': { fontSize: `${props.fontSize}px` } });

  useEffect(() => {
    const run = (mode: 'smart' | 'all') => () => {
      cb.current.onRun?.(mode);
      return true;
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: false }),
          highlightSelectionMatches(),
          search({ top: true }),
          placeholder('Écris ta requête ici.  Ctrl+Entrée : exécuter l’instruction courante · F5 : tout exécuter'),
          // Ctrl+E : plan estimé ; Ctrl+Maj+E : plan mesuré (selon la touche physique, quelle que soit la disposition)
          EditorView.domEventHandlers({
            keydown: (e) => {
              if (!(e.ctrlKey || e.metaKey) || e.altKey || e.code !== 'KeyE') return false;
              e.preventDefault();
              if (e.shiftKey) cb.current.onExplainAnalyze?.();
              else cb.current.onExplain?.();
              return true;
            },
          }),
          keymap.of([
            { key: 'Mod-Enter', run: run('smart'), preventDefault: true },
            { key: 'Shift-Mod-Enter', run: run('all'), preventDefault: true },
            { key: 'F5', run: run('all'), preventDefault: true },
            { key: 'Shift-Mod-f', run: () => (cb.current.onFormat?.(), true), preventDefault: true },
            { key: 'Mod-s', run: () => (cb.current.onSave?.(), true), preventDefault: true },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          baseTheme,
          lang.current.of(langExt()),
          theme.current.of(themeExt()),
          font.current.of(fontExt()),
          ro.current.of(EditorState.readOnly.of(!!props.readOnly)),
          currentStatementPlugin(() => cb.current.kind),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(langExt()) });
  }, [props.kind, props.mariadb, props.completion, props.uppercase]);
  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(themeExt()) });
  }, [props.dark]);
  useEffect(() => {
    view.current?.dispatch({ effects: font.current.reconfigure(fontExt()) });
  }, [props.fontSize]);
  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)) });
  }, [props.readOnly]);

  // valeur modifiée de l'extérieur (ouverture de fichier, historique…)
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  useImperativeHandle(ref, () => ({
    smartText() {
      const v = view.current!;
      const sel = v.state.selection.main;
      if (!sel.empty) return { text: v.state.sliceDoc(sel.from, sel.to), from: sel.from };
      const s = statementAt(v.state.doc.toString(), cb.current.kind, sel.head);
      return s ? { text: s.text, from: s.start } : null;
    },
    allText: () => view.current!.state.doc.toString(),
    setText: (t) => {
      const v = view.current!;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
    },
    replaceRange: (from, to, text) => view.current!.dispatch({ changes: { from, to, insert: text } }),
    selectionRange: () => {
      const s = view.current!.state.selection.main;
      return { from: s.from, to: s.to };
    },
    focus: () => view.current?.focus(),
    insert: (text) => {
      const v = view.current!;
      const s = v.state.selection.main;
      v.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length } });
      v.focus();
    },
  }));

  return <div className="editor-host" ref={host} />;
});

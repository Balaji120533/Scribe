'use client';

import { useRef, useState, useMemo } from 'react';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import type { DraggableAttributes } from '@dnd-kit/core';

type DragListeners = ReturnType<typeof useSortable>['listeners'];
import { CSS } from '@dnd-kit/utilities';
import type { PaperForm, SectionEntry, ContentItem } from '@/types/paper-form';
import { api } from '@/lib/api';
import type { ImageWarning } from '@/lib/api';
import { uid } from '@/types/paper-form';
import { findCitationHints } from '@/lib/citationHints';
import { subsectionNumbers, subsectionLabel } from '@/lib/numbering';
import EquationEditor from '@/components/form/EquationEditor';

type UploadResult = { ref: string; filename: string; warning?: ImageWarning | null };

interface Props {
  form: PaperForm;
  onChange: (patch: Partial<PaperForm>) => void;
  onUploadImage: (file: File) => Promise<UploadResult>;
}

const BASE_INPUT = 'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:border-black focus:ring-1 focus:ring-black transition-colors bg-white';
const SM_INPUT   = 'w-full px-2 py-1.5 rounded-md border border-gray-200 text-sm text-gray-700 placeholder-gray-300 focus:outline-none focus:border-black bg-white';

function updateSections(
  sections: SectionEntry[],
  secId: string,
  fn: (sec: SectionEntry) => SectionEntry,
): SectionEntry[] {
  return sections.map(s => s.id === secId ? fn(s) : s);
}

function updateContentItem(
  items: ContentItem[],
  itemId: string,
  patch: Record<string, unknown>,
): ContentItem[] {
  return items.map(i => i.id === itemId ? { ...i, ...patch } as ContentItem : i);
}

/** Small grip icon used as the drag handle for sections and content items. */
function GripHandle({ attributes, listeners }: { attributes: DraggableAttributes; listeners: DragListeners }) {
  return (
    <button
      type="button"
      {...attributes}
      {...listeners}
      title="Drag to reorder"
      aria-label="Drag to reorder"
      // Kept on the left, away from the ✕ on the right, so grabbing a block
      // never lands on its delete button. Mid-gray with a hover chip so it
      // reads as a control, not as faint decoration.
      className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 hover:bg-gray-200/70 transition-colors cursor-grab active:cursor-grabbing touch-none"
    >
      <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
        <circle cx="3" cy="2" r="1.3" /><circle cx="9" cy="2" r="1.3" />
        <circle cx="3" cy="8" r="1.3" /><circle cx="9" cy="8" r="1.3" />
        <circle cx="3" cy="14" r="1.3" /><circle cx="9" cy="14" r="1.3" />
      </svg>
    </button>
  );
}

export default function ContentBuilder({ form, onChange, onUploadImage }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setSections = (sections: SectionEntry[]) => onChange({ sections });

  const addSection = () => {
    setSections([
      ...form.sections,
      { id: uid(), heading: '', content: [{ id: uid(), kind: 'paragraph', text: '' }] },
    ]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50);
  };

  const removeSection = (id: string) =>
    setSections(form.sections.filter(s => s.id !== id));

  const updateHeading = (secId: string, heading: string) =>
    setSections(updateSections(form.sections, secId, s => ({ ...s, heading })));

  const patchContent = (secId: string, itemId: string, patch: Record<string, unknown>) =>
    setSections(updateSections(form.sections, secId, s => ({
      ...s,
      content: updateContentItem(s.content, itemId, patch),
    })));

  const addContent = (secId: string, kind: ContentItem['kind']) => {
    let newItem: ContentItem;
    switch (kind) {
      case 'paragraph':  newItem = { id: uid(), kind: 'paragraph', text: '' }; break;
      case 'figure':     newItem = { id: uid(), kind: 'figure', imageRef: '', filename: '', caption: '', wide: false }; break;
      case 'table':      newItem = { id: uid(), kind: 'table', caption: '', headerRow: true, wide: false, center: true,
                                     rows: [['', ''], ['', '']] }; break;
      case 'equation':   newItem = { id: uid(), kind: 'equation', latex: '' }; break;
      case 'list':       newItem = { id: uid(), kind: 'list', style: 'bullet', items: [''] }; break;
      case 'subsection': newItem = { id: uid(), kind: 'subsection', level: 2, text: '' }; break;
      default: return;
    }
    setSections(updateSections(form.sections, secId, s => ({ ...s, content: [...s.content, newItem] })));
    // Scroll so the new item and the add-buttons are both visible
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  };

  const removeContent = (secId: string, itemId: string) =>
    setSections(updateSections(form.sections, secId, s => ({
      ...s,
      content: s.content.filter(i => i.id !== itemId),
    })));

  const reorderContent = (secId: string, activeId: string, overId: string) =>
    setSections(updateSections(form.sections, secId, s => {
      const from = s.content.findIndex(i => i.id === activeId);
      const to = s.content.findIndex(i => i.id === overId);
      if (from < 0 || to < 0) return s;
      return { ...s, content: arrayMove(s.content, from, to) };
    }));

  const handleSectionDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = form.sections.findIndex(s => s.id === active.id);
    const to = form.sections.findIndex(s => s.id === over.id);
    if (from < 0 || to < 0) return;
    setSections(arrayMove(form.sections, from, to));
  };

  return (
    <div className="space-y-4 px-1">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}>
        <SortableContext items={form.sections.map(s => s.id)} strategy={verticalListSortingStrategy}>
          {form.sections.map((sec, idx) => (
            <SortableSection
              key={sec.id}
              sec={sec}
              idx={idx}
              canRemove={form.sections.length > 1}
              onHeadingChange={h => updateHeading(sec.id, h)}
              onRemove={() => removeSection(sec.id)}
              onAddContent={kind => addContent(sec.id, kind)}
              onPatchContent={(itemId, patch) => patchContent(sec.id, itemId, patch)}
              onRemoveContent={itemId => removeContent(sec.id, itemId)}
              onReorderContent={(activeId, overId) => reorderContent(sec.id, activeId, overId)}
              onUploadImage={onUploadImage}
              refCount={form.references.length}
            />
          ))}
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={addSection}
        className="w-full py-2.5 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-colors"
      >
        + Add Section
      </button>

      {/* Scroll anchor — newly added items scroll here */}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONTENT_KINDS = [
  { kind: 'paragraph'  as const, icon: '¶', label: 'Paragraph'   },
  { kind: 'subsection' as const, icon: '§', label: 'Sub-section' },
  { kind: 'figure'     as const, icon: '▢', label: 'Figure'      },
  { kind: 'table'      as const, icon: '▦', label: 'Table'       },
  { kind: 'equation'   as const, icon: '∑', label: 'Equation'    },
  { kind: 'list'       as const, icon: '•', label: 'List'        },
];

const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];

// ── Sortable section wrapper ─────────────────────────────────────────────────

interface SortableSectionProps {
  sec: SectionEntry;
  idx: number;
  canRemove: boolean;
  onHeadingChange: (heading: string) => void;
  onRemove: () => void;
  onAddContent: (kind: ContentItem['kind']) => void;
  onPatchContent: (itemId: string, patch: Record<string, unknown>) => void;
  onRemoveContent: (itemId: string) => void;
  onReorderContent: (activeId: string, overId: string) => void;
  onUploadImage: (file: File) => Promise<UploadResult>;
  refCount: number;
}

function SortableSection({
  sec, idx, canRemove, onHeadingChange, onRemove,
  onAddContent, onPatchContent, onRemoveContent, onReorderContent, onUploadImage, refCount,
}: SortableSectionProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sec.id });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleItemDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onReorderContent(String(active.id), String(over.id));
  };

  const subNumbers = subsectionNumbers(sec.content);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="border border-gray-200 rounded-xl overflow-hidden bg-white"
    >
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-2 py-2 bg-gray-50 border-b border-gray-200">
        <GripHandle attributes={attributes} listeners={listeners} />
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider w-5 flex-shrink-0">
          {(ROMAN[idx] ?? String(idx + 1))}.
        </span>
        <input
          className="flex-1 bg-transparent text-sm font-semibold text-gray-700 placeholder-gray-300 focus:outline-none min-w-0"
          placeholder="Section heading (e.g. Introduction)"
          value={sec.heading}
          onChange={e => onHeadingChange(e.target.value)}
        />
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-gray-300 hover:text-red-400 text-sm flex-shrink-0"
          >✕</button>
        )}
      </div>

      {/* Content items */}
      <div className="p-3 space-y-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleItemDragEnd}>
          <SortableContext items={sec.content.map(i => i.id)} strategy={verticalListSortingStrategy}>
            {sec.content.map(item => (
              <SortableItem
                key={item.id}
                item={item}
                subNumber={subNumbers.get(item.id)}
                canRemove={sec.content.length > 1}
                onPatch={patch => onPatchContent(item.id, patch)}
                onRemove={() => onRemoveContent(item.id)}
                onUploadImage={onUploadImage}
                refCount={refCount}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Add content buttons */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {CONTENT_KINDS.map(({ kind, icon, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => onAddContent(kind)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-gray-500 hover:text-gray-700 hover:bg-gray-100 border border-gray-200 transition-colors"
            >
              <span>{icon}</span> {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Sortable content item wrapper ────────────────────────────────────────────

interface SortableItemProps {
  item: ContentItem;
  /** This sub-section's letter/number within its section (sub-sections only). */
  subNumber?: string;
  canRemove: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  onUploadImage: (file: File) => Promise<UploadResult>;
  refCount: number;
}

function SortableItem({ item, subNumber, canRemove, onPatch, onRemove, onUploadImage, refCount }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-start gap-1"
    >
      <div className="pt-2.5">
        <GripHandle attributes={attributes} listeners={listeners} />
      </div>
      <div className="flex-1 min-w-0">
        <ItemEditor
          item={item}
          subNumber={subNumber}
          canRemove={canRemove}
          onPatch={onPatch}
          onRemove={onRemove}
          onUploadImage={onUploadImage}
          refCount={refCount}
        />
      </div>
    </div>
  );
}

// ── Citation typo hints ──────────────────────────────────────────────────────

/**
 * Surfaces malformed citations directly under the paragraph that contains
 * them. The compiler passes unrecognised brackets through verbatim, so without
 * this the mistake is invisible until the user opens the finished document.
 */
function CitationHints({
  text, refCount, onFix,
}: {
  text: string;
  refCount: number;
  onFix: (from: string, to: string) => void;
}) {
  const hints = useMemo(() => findCitationHints(text, refCount), [text, refCount]);
  if (hints.length === 0) return null;

  return (
    <div className="mt-1.5 space-y-1">
      {hints.map(h => (
        <div key={h.found} className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-amber-500"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <code className="px-1 py-0.5 bg-gray-100 rounded text-gray-700">{h.found}</code>
          <span>{h.reason}.</span>
          {h.suggestion && (
            <button
              type="button"
              onClick={() => onFix(h.found, h.suggestion!)}
              className="text-gray-700 underline underline-offset-2 hover:text-black"
            >
              Change to {h.suggestion}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Per-item editor ──────────────────────────────────────────────────────────

interface ItemEditorProps {
  item: ContentItem;
  subNumber?: string;
  canRemove: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  onUploadImage: (file: File) => Promise<UploadResult>;
  refCount: number;
}

function ItemEditor({ item, subNumber, canRemove, onPatch, onRemove, onUploadImage, refCount }: ItemEditorProps) {
  const removeBtn = canRemove ? (
    <button
      type="button"
      onClick={onRemove}
      className="ml-1 flex-shrink-0 text-gray-300 hover:text-red-400"
    >✕</button>
  ) : null;

  switch (item.kind) {
    case 'paragraph':
      return (
        <div className="flex gap-1">
          <div className="flex-1 min-w-0">
            <textarea
              className={`${BASE_INPUT} resize-none`}
              rows={3}
              placeholder="Type or paste your paragraph text here…"
              value={item.text}
              onChange={e => onPatch({ text: e.target.value })}
            />
            <CitationHints
              text={item.text}
              refCount={refCount}
              onFix={(from, to) => onPatch({ text: item.text.split(from).join(to) })}
            />
          </div>
          {removeBtn}
        </div>
      );

    case 'subsection':
      return (
        <div className="flex items-center gap-2 pl-3 border-l-2 border-gray-200">
          {/* This sub-section's own label — "A.", "B.", "1)", "2)" — the same
              one the preview and the compiled paper print (lib/numbering). */}
          <span className="text-[11px] font-bold text-gray-500 w-5 flex-shrink-0 tabular-nums">
            {subNumber ? subsectionLabel(item.level, subNumber) : ''}
          </span>
          <select
            className="text-[11px] border border-gray-200 rounded px-1 py-1 text-gray-600 bg-white"
            value={item.level}
            onChange={e => onPatch({ level: Number(e.target.value) })}
          >
            <option value={2}>Sub-section</option>
            <option value={3}>Sub-sub-section</option>
          </select>
          <input
            className={`${SM_INPUT} flex-1`}
            placeholder="Sub-section heading"
            value={item.text}
            onChange={e => onPatch({ text: e.target.value })}
          />
          {removeBtn}
        </div>
      );

    case 'figure':
      return (
        <FigureEditor
          item={item}
          removeBtn={removeBtn}
          onPatch={onPatch}
          onUploadImage={onUploadImage}
        />
      );

    case 'table':
      return <TableEditor item={item} removeBtn={removeBtn} onPatch={onPatch} />;

    case 'equation':
      return <EquationEditor latex={item.latex} removeBtn={removeBtn} onPatch={onPatch} />

    case 'list':
      return (
        <div className="bg-gray-50 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <select
              className="text-[11px] border border-gray-200 rounded px-1 py-1 text-gray-600 bg-white"
              value={item.style}
              onChange={e => onPatch({ style: e.target.value })}
            >
              <option value="bullet">• Bullet list</option>
              <option value="numbered">1. Numbered list</option>
            </select>
            {removeBtn}
          </div>
          {item.items.map((it, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="text-[11px] text-gray-400 w-4">
                {item.style === 'bullet' ? '•' : `${i + 1}.`}
              </span>
              <input
                className={`${SM_INPUT} flex-1`}
                placeholder={`Item ${i + 1}`}
                value={it}
                onChange={e => {
                  const items = [...item.items];
                  items[i] = e.target.value;
                  onPatch({ items });
                }}
              />
              {item.items.length > 1 && (
                <button
                  type="button"
                  onClick={() => onPatch({ items: item.items.filter((_, j) => j !== i) })}
                  className="text-gray-300 hover:text-red-400"
                >✕</button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => onPatch({ items: [...item.items, ''] })}
            className="text-[11px] text-black hover:text-gray-600 underline underline-offset-2"
          >
            + Add item
          </button>
        </div>
      );

    default:
      return null;
  }
}

// ── Table editor (visual grid) ─────────────────────────────────────────────────

interface TableEditorProps {
  item: Extract<ContentItem, { kind: 'table' }>;
  removeBtn: React.ReactNode;
  onPatch: (patch: Record<string, unknown>) => void;
}

function TableEditor({ item, removeBtn, onPatch }: TableEditorProps) {
  const rows = item.rows;
  const nCols = rows[0]?.length ?? 0;
  const centered = item.center ?? true;

  const setCell = (r: number, c: number, val: string) => {
    const next = rows.map(row => [...row]);
    next[r][c] = val;
    onPatch({ rows: next });
  };

  const addRow = () =>
    onPatch({ rows: [...rows.map(r => [...r]), Array(nCols).fill('')] });

  const removeRow = (r: number) =>
    onPatch({ rows: rows.filter((_, i) => i !== r) });

  const addCol = () =>
    onPatch({ rows: rows.map(row => [...row, '']) });

  const removeCol = (c: number) =>
    onPatch({ rows: rows.map(row => row.filter((_, i) => i !== c)) });

  return (
    <div className="bg-gray-50 rounded-lg p-3 space-y-2 border border-gray-100">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Table</span>
        {removeBtn}
      </div>

      {/* Grid — one <input> per cell. First row styled as header when enabled. */}
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="p-0.5">
                    {/* Auto-growing textarea so the cell wraps to a new line
                        on Enter/Shift+Enter, and the editor mirrors exactly
                        what renders (including manual line breaks). */}
                    <textarea
                      rows={1}
                      className={`w-24 px-1.5 py-1 rounded border text-[11px] bg-white resize-none overflow-hidden focus:outline-none focus:border-black ${
                        centered ? 'text-center' : 'text-left'
                      } ${
                        item.headerRow && r === 0
                          ? 'border-gray-400 font-semibold text-gray-800'
                          : 'border-gray-200 text-gray-700'
                      }`}
                      placeholder={item.headerRow && r === 0 ? `Header ${c + 1}` : ''}
                      value={cell}
                      onChange={e => setCell(r, c, e.target.value)}
                      ref={el => {
                        // Grow to fit content so wrapped/multi-line text is fully visible.
                        if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
                      }}
                    />
                  </td>
                ))}
                {/* Delete-row control */}
                <td className="pl-1">
                  {rows.length > 1 && (
                    <button
                      type="button"
                      title="Delete row"
                      onClick={() => removeRow(r)}
                      className="text-gray-300 hover:text-red-400 text-[11px]"
                    >✕</button>
                  )}
                </td>
              </tr>
            ))}
            {/* Delete-column controls under each column */}
            <tr>
              {rows[0]?.map((_, c) => (
                <td key={c} className="text-center">
                  {nCols > 1 && (
                    <button
                      type="button"
                      title="Delete column"
                      onClick={() => removeCol(c)}
                      className="text-gray-300 hover:text-red-400 text-[10px]"
                    >✕</button>
                  )}
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={addRow}
          className="px-2 py-1 rounded-md text-[11px] text-gray-600 hover:bg-gray-100 border border-gray-200"
        >+ Row</button>
        <button
          type="button"
          onClick={addCol}
          className="px-2 py-1 rounded-md text-[11px] text-gray-600 hover:bg-gray-100 border border-gray-200"
        >+ Column</button>
      </div>

      <input
        className={SM_INPUT}
        placeholder="Caption (e.g. Comparison of model accuracy across datasets.)"
        value={item.caption}
        onChange={e => onPatch({ caption: e.target.value })}
      />

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-[11px] text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={item.headerRow}
            onChange={e => onPatch({ headerRow: e.target.checked })}
            className="w-3 h-3 accent-black"
          />
          First row is header
        </label>
        <label className="flex items-center gap-2 text-[11px] text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={centered}
            onChange={e => onPatch({ center: e.target.checked })}
            className="w-3 h-3 accent-black"
          />
          Center cells
        </label>
        <label className="flex items-center gap-2 text-[11px] text-gray-500 cursor-pointer">
          <input
            type="checkbox"
            checked={item.wide}
            onChange={e => onPatch({ wide: e.target.checked })}
            className="w-3 h-3 accent-black"
          />
          Full-width (spans both columns)
        </label>
      </div>
    </div>
  );
}

// ── Figure editor (upload state + validation) ──────────────────────────────────

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // must match the gateway multipart limit
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

interface FigureEditorProps {
  item: Extract<ContentItem, { kind: 'figure' }>;
  removeBtn: React.ReactNode;
  onPatch: (patch: Record<string, unknown>) => void;
  onUploadImage: (file: File) => Promise<UploadResult>;
}

function FigureEditor({ item, removeBtn, onPatch, onUploadImage }: FigureEditorProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;

    // ── Client-side image check ──
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(`Unsupported file type "${file.type || 'unknown'}". Use PNG, JPG, GIF, WebP or SVG.`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — max is 20 MB.`);
      return;
    }

    setError(null);
    setUploading(true);
    try {
      const { ref, filename } = await onUploadImage(file);
      onPatch({ imageRef: ref, filename });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Upload failed: ${msg}`);
    } finally {
      setUploading(false);
    }
  };

  const previewUrl = item.imageRef ? api.imageUrl(item.imageRef) : '';

  return (
    <div className="bg-gray-50 rounded-lg p-3 space-y-2 border border-gray-100">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Figure</span>
        {removeBtn}
      </div>

      {/* Upload zone — label wraps a hidden input so the click always works */}
      {item.imageRef ? (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={item.filename}
            className="w-12 h-12 object-cover rounded border border-gray-200 bg-white flex-shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-gray-600 font-mono truncate">✓ {item.filename || item.imageRef}</p>
            <label className="text-[11px] text-black hover:text-gray-600 cursor-pointer underline underline-offset-2">
              {uploading ? 'Uploading…' : 'Change image'}
              <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
            </label>
          </div>
        </div>
      ) : (
        <label
          className={`flex items-center justify-center w-full py-3 border-2 border-dashed rounded-lg text-sm transition-colors cursor-pointer ${
            uploading
              ? 'border-gray-300 text-gray-500 cursor-wait'
              : 'border-gray-200 text-gray-400 hover:text-gray-600 hover:border-gray-300'
          }`}
        >
          {uploading ? 'Uploading…' : '+ Click to upload image'}
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
      )}

      {error && <p className="text-[11px] text-red-500 leading-tight">{error}</p>}

      <input
        className={SM_INPUT}
        placeholder="Caption (e.g. System architecture showing the three-tier pipeline.)"
        value={item.caption}
        onChange={e => onPatch({ caption: e.target.value })}
      />
      <label className="flex items-center gap-2 text-[11px] text-gray-500 cursor-pointer">
        <input
          type="checkbox"
          checked={item.wide}
          onChange={e => onPatch({ wide: e.target.checked })}
          className="w-3 h-3 accent-black"
        />
        Full-width (spans both columns)
      </label>
    </div>
  );
}

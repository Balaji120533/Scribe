'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { DocPreview, PreviewBlock } from '@/lib/parsePreview';
import { resolveCitations } from '@/lib/parsePreview';
import MathBlock from './MathBlock';

interface Props {
  preview: DocPreview;
  /** Display scale for the page stack. Layout/pagination always run at 1 —
   *  this only scales the rendered result, so page breaks never depend on it. */
  zoom?: number;
}

// ── Page geometry ────────────────────────────────────────────────────────────
// Derived from the engine's real A4 setup (engine/renderer/styles.py) so the
// preview is proportionally honest rather than eyeballed:
//
//   page      595.30 × 841.90 pt   (A4, 210 × 297 mm)
//   margins   left/right 45.35pt, top 54pt, bottom 72pt
//
// Everything below scales those points by PT_TO_PX. Keeping one scale factor
// means the page card, its margins and its columns can never drift out of
// proportion with each other the way hand-picked pixel values did.
const PAGE_W_PT = 595.30;
const PAGE_H_PT = 841.90;
const MARGIN_X_PT = 45.35;
const MARGIN_TOP_PT = 54;
const MARGIN_BOTTOM_PT = 72;

// Chosen so the page card is ~640px wide, matching the previous layout width.
const PT_TO_PX = 640 / PAGE_W_PT;

// True A4 aspect: 640 × 905 rather than the old 640 × ~860.
const PAGE_HEIGHT = Math.round(PAGE_H_PT * PT_TO_PX);

// Usable vertical space for the two-column body, once the page's own top and
// bottom margins are removed. The header (title/authors) and footer are
// subtracted from this at render time.
const PAGE_COLUMN_HEIGHT = Math.round(
  (PAGE_H_PT - MARGIN_TOP_PT - MARGIN_BOTTOM_PT) * PT_TO_PX
);

// Vertical padding on the two-column body row (py-3 = 12px top + 12px bottom).
// With box-sizing:border-box the row's inner content area is shorter than
// PAGE_COLUMN_HEIGHT by this amount, so pagination must fill only up to the
// inner height — otherwise the last line of a full column bleeds past the
// padding and over the page's bottom edge / footer.
const COLUMN_BODY_PADDING_Y = 12; // py-3, one side
const COLUMN_FILL_BUDGET = PAGE_COLUMN_HEIGHT - COLUMN_BODY_PADDING_Y * 2;

// Fixed page card width. Must be an exact px width (not max-width) so it can
// never be squeezed narrower by its flex container — the hidden measurement
// pass below computes column width from this same constant, so measured
// heights always match what actually renders. A mismatch here is what let
// text/images overflow past the visible page edge.
const PAGE_WIDTH = Math.round(PAGE_W_PT * PT_TO_PX);
// Real A4 side margins (45.35pt ≈ 48px), not the old 24px. This is the change
// that makes the text block occupy the same 84.8% of page width as the .docx,
// instead of an over-wide 92.5%.
const PAGE_PADDING_X = Math.round(MARGIN_X_PT * PT_TO_PX);
const COLUMN_GAP = 12;     // 0.75rem
// Small safety margin subtracted from the true column width so justified text
// wraps a little before the hard edge — sub-pixel rounding in the browser's
// justify algorithm can otherwise let the last word of a line bleed past the
// column boundary instead of breaking to the next line.
const COLUMN_SAFETY_MARGIN = 6;
const COLUMN_WIDTH = (PAGE_WIDTH - PAGE_PADDING_X * 2 - COLUMN_GAP) / 2 - COLUMN_SAFETY_MARGIN;

// The columns use border-box, so the left column's inner TEXT width is smaller
// than COLUMN_WIDTH by its right padding + right border, while the measurement
// pass has neither. If we measured at the full COLUMN_WIDTH, the left column's
// text would wrap to more lines than measured and the last paragraph would
// overflow the column bottom (visible when editing an end-of-column paragraph:
// it grew but was not re-flowed to the next column). Measure at the narrowest
// real content width so height is never underestimated for either column.
const COLUMN_INNER_BORDER = 1;  // borderRight on the left column
const MEASURE_WIDTH = COLUMN_WIDTH - COLUMN_GAP / 2 - COLUMN_INNER_BORDER;

// ── Type scale ───────────────────────────────────────────────────────────────
// Every size below is the template's real point size converted through the same
// PT_TO_PX used for the page geometry, so text occupies the same proportion of
// the column as it does in the .docx. These were previously hand-picked pixel
// values ~25-45% too small, which is why preview line breaks and page breaks
// did not match the compiled document.
//
// Point sizes read from engine/templates/ieee_template.docx via python-docx:
//   paper title 24 · subtitle 14 · Author 11 · Abstract 9 · Affiliation 9
//   body (Normal, Word's default) 10 · figure caption 8 · table copy 8
//   references 8
const pt = (points: number) => `${(points * PT_TO_PX).toFixed(2)}px`;

const FS = {
  title:      pt(24),
  author:     pt(11),
  affiliation: pt(9),
  abstract:   pt(9),
  body:       pt(10),
  caption:    pt(8),
  table:      pt(8),
  references: pt(8),
  // Section headings inherit the 10pt body size in the template; IEEE styles
  // them by case and weight rather than by size.
  heading:    pt(10),
} as const;

// "Body Text" in the template is 11.40pt line spacing on 10pt type, with 6pt
// after each paragraph. Tailwind's leading-relaxed (1.625) made paragraphs
// ~42% taller than the document, which shifted every page break.
const BODY_LINE_HEIGHT = 11.4 / 10;

// Pixel equivalents used by the paginator when it splits a paragraph across
// columns: one body line, and the 6pt space-after a paragraph ends with.
const BODY_LINE_PX = 10 * PT_TO_PX * BODY_LINE_HEIGHT;
const PARAGRAPH_GAP_PX = 6 * PT_TO_PX;

const HEADING_CLS: Record<1 | 2 | 3, string> = {
  1: 'font-bold uppercase tracking-wider text-center mt-4 mb-1',
  2: 'font-semibold italic mt-3 mb-0.5',
  3: 'italic mt-2 mb-0.5',
};

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function headingText(b: Extract<PreviewBlock, { kind: 'heading' }>): string {
  if (!b.numbering) return b.text;
  if (b.level === 1) return `${b.numbering}. ${b.text.toUpperCase()}`;
  if (b.level === 2) return `${b.numbering}. ${b.text}`;
  return `${b.numbering}) ${b.text}`;
}

/** `continues` marks a paragraph fragment that carries on in the next column:
 *  no space-after, and its last line is justified like any interior line. */
function Block({ block, refCount, continues = false }: { block: PreviewBlock; refCount: number; continues?: boolean }) {
  switch (block.kind) {
    case 'heading':
      return <div className={`${HEADING_CLS[block.level]} break-inside-avoid`} style={{ fontSize: FS.heading }}>{headingText(block)}</div>;

    case 'paragraph':
      return (
        <p
          className="text-justify text-gray-700"
          style={{
            fontSize: FS.body,
            lineHeight: BODY_LINE_HEIGHT,
            marginBottom: continues ? 0 : pt(6),
            textAlignLast: continues ? 'justify' : undefined,
          }}
        >
          {resolveCitations(block.text, refCount)}
        </p>
      );

    case 'equation':
      return (
        <div className="break-inside-avoid my-1.5 flex items-center justify-center gap-2">
          <MathBlock latex={block.latex} className="overflow-x-auto" />
          <span className="text-gray-400 flex-shrink-0" style={{ fontSize: FS.caption }}>{block.label}</span>
        </div>
      );

    case 'figure':
      return (
        <figure className="break-inside-avoid my-2">
          {block.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={block.imageUrl}
              alt={block.caption || block.label}
              className="w-full object-contain border border-gray-100 bg-gray-50"
              style={{ maxHeight: 120 }}
            />
          ) : (
            <div
              className="border border-gray-200 bg-gray-50 flex items-center justify-center"
              style={{ height: 48 }}
            >
              <span className="text-gray-400" style={{ fontSize: FS.caption }}>{block.label}</span>
            </div>
          )}
          {block.caption && (
            <figcaption className="text-gray-600 text-center mt-0.5 leading-tight" style={{ fontSize: FS.caption }}>
              <span className="font-semibold">{block.label}.</span> {block.caption}
            </figcaption>
          )}
        </figure>
      );

    case 'table':
      return (
        <figure className="break-inside-avoid my-2">
          {/* Caption above the table — IEEE convention (mirrors the .docx). */}
          <figcaption className="text-gray-600 text-center mb-0.5 leading-tight" style={{ fontSize: FS.caption }}>
            <span className="font-semibold uppercase">{block.label}.</span>{' '}
            {block.caption}
          </figcaption>
          <table
            className="w-full border-collapse"
            style={{ fontSize: FS.table, tableLayout: 'fixed' }}
          >
            <tbody>
              {block.rows.map((row, r) => {
                const isHead = block.headerRow && r === 0;
                const align = block.center ?? true ? 'center' : 'left';
                return (
                  <tr key={r}>
                    {row.map((cell, c) => {
                      const CellTag = isHead ? 'th' : 'td';
                      return (
                        <CellTag
                          key={c}
                          className={`border border-gray-400 px-1 py-0.5 align-top ${
                            isHead ? 'font-semibold' : ''
                          }`}
                          style={{
                            textAlign: isHead ? 'center' : align,
                            // Preserve manual line breaks the user typed in a cell.
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'break-word',
                            wordBreak: 'break-word',
                          }}
                        >
                          {cell}
                        </CellTag>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </figure>
      );

    case 'list':
      return (
        <ul className="text-gray-700 mb-1 pl-3 space-y-0.5" style={{ fontSize: FS.body }}>
          {block.items.map((it, i) => (
            <li key={i} className="leading-tight">
              <span className="text-gray-400 mr-1">{block.style === 'bullet' ? '•' : `${i + 1}.`}</span>
              {resolveCitations(it, refCount)}
            </li>
          ))}
        </ul>
      );

    default:
      return null;
  }
}

// One flowable item in the column-fill stream. 'abstract' is always item 0
// when present; references are appended as the final item. A paragraph too
// long for the space left in a column is split into several 'block' items,
// all but the last flagged `continues`.
type FlowItem =
  | { kind: 'abstract'; abstract: string; keywords: string[] }
  | { kind: 'block'; block: PreviewBlock; index: number; continues?: boolean }
  | { kind: 'references'; refs: DocPreview['references'] };

/** Wraps each flow item as a block formatting context. Without it, a child's
 *  top/bottom margins collapse through the wrapper, so the measured height
 *  leaves them out while the rendered column still includes them — every
 *  paragraph was under-measured by its space-after and the column bottom
 *  got clipped. Used identically in the measurement pass and the columns. */
function FlowSlot({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flow-root' }}>{children}</div>;
}

function FlowItemView({ item, refCount }: { item: FlowItem; refCount: number }) {
  switch (item.kind) {
    case 'abstract':
      return (
        // Mirrors the template's styles: "Abstract" is 9pt bold, and
        // "Keywords" (based on it) adds italic — so the abstract body is bold
        // and the index terms are bold italic, with the labels bold italic.
        <div className="mb-1">
          {item.abstract && (
            <div className="text-justify font-bold" style={{ fontSize: FS.abstract, lineHeight: BODY_LINE_HEIGHT }}>
              <em className="italic">Abstract—</em>
              {item.abstract}
            </div>
          )}
          {item.keywords.length > 0 && (
            <div className="mt-1 text-justify font-bold italic" style={{ fontSize: FS.abstract, lineHeight: BODY_LINE_HEIGHT }}>
              Index Terms—{item.keywords.join(', ')}
            </div>
          )}
        </div>
      );
    case 'block':
      return <Block block={item.block} refCount={refCount} continues={item.continues} />;
    case 'references':
      return (
        <div className="break-inside-avoid mt-3">
          <p className="font-bold uppercase text-center mb-1" style={{ fontSize: FS.references }}>References</p>
          {item.refs.map(ref => (
            <p
              key={ref.key}
              className="text-gray-600 mb-0.5 leading-tight text-justify"
              style={{ fontSize: FS.references, paddingLeft: 10, textIndent: -10 }}
            >
              <span className="font-semibold">[{ref.key}]</span> {ref.text}
            </p>
          ))}
        </div>
      );
  }
}

// A page's two explicit columns — content is placed directly, no CSS
// multi-column auto-flow, so a browser can never render an implicit 3rd
// column that bleeds past the visible page edge.
type PageColumns = { left: FlowItem[]; right: FlowItem[] };

export default function PaperPreview({ preview, zoom = 1 }: Props) {
  const measureRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scratchRef = useRef<HTMLParagraphElement>(null);
  const [pages, setPages] = useState<PageColumns[] | null>(null);

  // Wide figures/tables span both columns; render them outside the column flow.
  const isWide = (b: PreviewBlock) =>
    (b.kind === 'figure' || b.kind === 'table') && b.wide;
  const columnBlocks = preview.blocks.filter(b => !isWide(b));
  const wideFigures  = preview.blocks.filter(isWide);

  const flowItems: FlowItem[] = [
    ...(preview.abstract || preview.keywords.length > 0
      ? [{ kind: 'abstract', abstract: preview.abstract, keywords: preview.keywords } as FlowItem]
      : []),
    ...columnBlocks.map((block, index) => ({ kind: 'block', block, index } as FlowItem)),
    ...(preview.references.length > 0
      ? [{ kind: 'references', refs: preview.references } as FlowItem]
      : []),
  ];

  // Measure each flow item's real rendered height (off-screen), then place
  // items one at a time into the current column until it's full, moving to
  // the next column (then the next page) — the same left-to-right,
  // top-to-bottom flow a real two-column document uses, but computed
  // explicitly instead of relying on CSS multi-column auto-flow (which can
  // render an implicit extra column that bleeds past the page edge when
  // content doesn't divide evenly into exactly two columns).
  const recomputePages = () => {
    const list = listRef.current;
    const scratch = scratchRef.current;
    if (!list || !scratch) return;

    const heights = Array.from(list.children).map(
      child => (child as HTMLElement).getBoundingClientRect().height,
    );

    // Height of a margin-less body paragraph holding `text`, at column width.
    const measureText = (text: string) => {
      scratch.textContent = text;
      return scratch.getBoundingClientRect().height;
    };

    // Largest k such that the first k words still fit in `space` pixels.
    // Height only grows with k, so a binary search finds the last word of
    // the last whole line that fits.
    const fitWords = (words: string[], space: number) => {
      let lo = 0;
      let hi = words.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureText(words.slice(0, mid).join(' ')) <= space + 0.5) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };

    const bucketed: PageColumns[] = [];
    let left: FlowItem[] = [];
    let right: FlowItem[] = [];
    let col: 'left' | 'right' = 'left';
    let colHeight = 0;

    const pushPage = () => {
      bucketed.push({ left, right });
      left = [];
      right = [];
      col = 'left';
      colHeight = 0;
    };
    const current = () => (col === 'left' ? left : right);
    const nextColumn = () => {
      if (col === 'left') {
        col = 'right';
        colHeight = 0;
      } else {
        pushPage();
      }
    };
    const place = (item: FlowItem, h: number) => {
      current().push(item);
      colHeight += h;
    };

    const refCount = preview.references.length;

    flowItems.forEach((item, i) => {
      const h = heights[i] ?? 0;

      // Paragraphs flow line by line: whatever fits fills the bottom of this
      // column and the rest continues at the top of the next one, like a
      // real two-column page — rather than the whole paragraph jumping
      // across and leaving a gap.
      if (item.kind === 'block' && item.block.kind === 'paragraph') {
        // Resolve citations first so a split can never land inside "[CITE 1]".
        let words = resolveCitations(item.block.text, refCount).split(/\s+/).filter(Boolean);
        let height = h;
        let fragmented = false;

        for (;;) {
          const space = COLUMN_FILL_BUDGET - colHeight;
          const rest = { kind: 'block', index: item.index, block: { kind: 'paragraph', text: words.join(' ') } } as FlowItem;

          if (height <= space + 0.5) {
            place(fragmented ? rest : item, height);
            break;
          }

          const k = fitWords(words, space);
          if (k >= words.length) {
            // The text fits; only its trailing space-after doesn't. That
            // space is invisible at the bottom of a column, so keep it here.
            place(fragmented ? rest : item, space);
            break;
          }
          if (k === 0) {
            // Not even one line fits. An empty column can always take at
            // least one line, so this only happens with content above it.
            if (current().length === 0) {
              place(fragmented ? rest : item, height);
              break;
            }
            nextColumn();
            continue;
          }

          const head = words.slice(0, k).join(' ');
          place(
            { kind: 'block', index: item.index, continues: true, block: { kind: 'paragraph', text: head } },
            measureText(head),
          );
          nextColumn();
          words = words.slice(k);
          height = measureText(words.join(' ')) + PARAGRAPH_GAP_PX;
          fragmented = true;
        }
        return;
      }

      // Everything else is placed whole. A heading also needs room for one
      // line of what follows, so it is never stranded alone at the bottom
      // of a column with its text starting in the next.
      const next = flowItems[i + 1];
      const keepWithNext = item.kind === 'block' && item.block.kind === 'heading' && next !== undefined;
      const needed = keepWithNext ? h + BODY_LINE_PX : h;
      if (current().length > 0 && colHeight + needed > COLUMN_FILL_BUDGET + 0.5) nextColumn();
      place(item, h);
    });
    if (left.length > 0 || right.length > 0) pushPage();
    if (bucketed.length === 0) bucketed.push({ left: [], right: [] });

    setPages(bucketed);
  };

  useLayoutEffect(() => {
    recomputePages();

    // Images load asynchronously after mount, so the first measurement pass
    // can undercount a figure's real height (browsers report ~0 height for
    // an <img> before its data arrives) — that produced wrong page splits
    // that only "corrected" on a later unrelated re-render, which looked
    // like the preview snapping back to a stale layout after refresh.
    // Re-measure once every image in the hidden pass has actually loaded.
    const container = measureRef.current;
    const imgs = container ? Array.from(container.querySelectorAll('img')) : [];
    const pending = imgs.filter(img => !img.complete);
    if (pending.length === 0) return;

    let remaining = pending.length;
    const onSettle = () => {
      remaining -= 1;
      if (remaining === 0) recomputePages();
    };
    pending.forEach(img => {
      img.addEventListener('load', onSettle, { once: true });
      img.addEventListener('error', onSettle, { once: true });
    });
    return () => {
      pending.forEach(img => {
        img.removeEventListener('load', onSettle);
        img.removeEventListener('error', onSettle);
      });
    };
    // Re-measure on zoom too: the inverse-zoom on the measurement container
    // leaves sub-pixel rounding differences between scales, which can nudge a
    // borderline block across a column boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, zoom]);

  if (!preview.hasContent) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-300 select-none gap-3 py-16">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="7" y1="8" x2="17" y2="8" />
          <line x1="7" y1="12" x2="17" y2="12" />
          <line x1="7" y1="16" x2="13" y2="16" />
        </svg>
        <p className="text-xs text-gray-400">Fill in the form on the left to see a live preview</p>
      </div>
    );
  }

  // Before the first measurement pass completes, show everything in the left
  // column as a reasonable placeholder rather than blocking on layout.
  const displayPages = pages ?? [{ left: flowItems, right: [] }];

  return (
    <div
      className="select-none"
      style={{
        fontFamily: '"Times New Roman", Times, serif',
        fontSize: FS.body,
        // CSS `zoom` rather than `transform: scale()`: zoom also scales the
        // element's layout box, so the scroll container reserves the right
        // amount of room automatically. A transform would leave the original
        // footprint behind, clipping pages when zoomed in.
        //
        // The measurement pass below cancels this back out, so page breaks are
        // computed at true size and stay identical at every zoom level.
        zoom: zoom === 1 ? undefined : zoom,
      }}
    >
      {/* Hidden measurement pass: render every flow item once, off-screen, at
          the same width it will render at on a real page, to get true heights. */}
      <div
        ref={measureRef}
        aria-hidden
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          top: -99999,
          left: -99999,
          width: MEASURE_WIDTH,
          // Cancel the wrapper's zoom. getBoundingClientRect() returns scaled
          // values, so without this every measured height would be multiplied
          // by the zoom factor and pagination would change as the user zoomed.
          zoom: zoom === 1 ? undefined : 1 / zoom,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
        }}
      >
        <div ref={listRef}>
          {flowItems.map((item, i) => (
            <FlowSlot key={i}>
              <FlowItemView item={item} refCount={preview.references.length} />
            </FlowSlot>
          ))}
        </div>
        {/* Scratch paragraph for measuring candidate split points. Styled like
            a body paragraph minus its space-after; its text is set imperatively. */}
        <p
          ref={scratchRef}
          className="text-justify"
          style={{ fontSize: FS.body, lineHeight: BODY_LINE_HEIGHT, margin: 0 }}
        />
      </div>

      {displayPages.map((cols, pageIndex) => (
        <div
          key={pageIndex}
          className="bg-white shadow-lg mx-4 my-4 overflow-hidden text-gray-900 flex flex-col"
          style={{
            width: PAGE_WIDTH,
            // A page is always a full A4 sheet, even when the content is short —
            // otherwise a half-empty first page renders as a stub and gives a
            // false impression of how much space is left.
            minHeight: PAGE_HEIGHT,
            flexShrink: 0,
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
        >
          {/* Header: single-column section (title/authors/affiliations only), page 1 only */}
          {pageIndex === 0 && (
            <div
              className="pb-3 border-b border-gray-200"
              style={{
                paddingLeft: PAGE_PADDING_X,
                paddingRight: PAGE_PADDING_X,
                paddingTop: Math.round(MARGIN_TOP_PT * PT_TO_PX),
              }}
            >
              <h1 className="font-bold text-center leading-tight mb-1 tracking-wide" style={{ fontSize: FS.title }}>
                {preview.title || 'Untitled Paper'}
              </h1>

              {preview.authorBlocks.length > 0 && (
                <div className="mb-0.5">
                  {chunk(preview.authorBlocks, 3).map((row, r) => (
                    <div key={r} className="flex justify-center gap-x-6 mb-2 last:mb-0">
                      {row.map((lines, i) => (
                        <div key={i} className="flex-1 text-center text-gray-700 leading-tight" style={{ fontSize: FS.affiliation }}>
                          {lines.map((line, j) => (
                            // First line is the author's name (11pt "Author"
                            // style); the rest are 9pt affiliation lines.
                            <p key={j} style={j === 0 ? { fontSize: FS.author } : undefined}>
                              {line}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Wide figures — full width, above the columns, page 1 only */}
          {pageIndex === 0 && wideFigures.map((b, i) => (
            <div
              key={`wide-${i}`}
              className="pt-2"
              style={{ paddingLeft: PAGE_PADDING_X, paddingRight: PAGE_PADDING_X }}
            >
              <Block block={b} refCount={preview.references.length} />
            </div>
          ))}

          {/* Body: two explicit columns per page, placed directly (no CSS
              multi-column auto-flow) so a browser can never spill an implicit
              extra column past the page's right edge. Abstract/Index Terms
              sit at the top of the left column so following content (e.g.
              Introduction) fills the rest of that column before overflowing
              into the right column — matching the Word table-in-2-col-section
              behavior. Each column has a hard width + clip as a backstop
              against any single line that's a sub-pixel too wide. */}
          <div
            className="py-3 flex flex-1 min-h-0"
            style={{
              // A cap, not a fixed height: page 1 also carries the header and
              // any wide figures, so its body row must be free to shrink. flex-1
              // lets it take exactly the space those leave behind, which keeps
              // every page a true A4 sheet regardless of what sits above.
              maxHeight: PAGE_COLUMN_HEIGHT,
              paddingLeft: PAGE_PADDING_X,
              paddingRight: PAGE_PADDING_X,
              gap: COLUMN_GAP,
              boxSizing: 'border-box',
            }}
          >
            {pageIndex === 0 && cols.left.length === 0 && cols.right.length === 0 && (
              <p className="text-[8px] text-gray-400 italic">
                Add a section heading and some content on the left to see the structure.
              </p>
            )}

            <div
              style={{
                width: COLUMN_WIDTH,
                flexShrink: 0,
                overflow: 'hidden',
                borderRight: '1px solid #e5e7eb',
                paddingRight: COLUMN_GAP / 2,
                // Match the measurement container's wrapping so a long or
                // unbreakable run (e.g. a word glued to a "[1]" citation) wraps
                // here instead of overflowing and being clipped by overflow:hidden.
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
              }}
            >
              {cols.left.map((item, i) => (
                <FlowSlot key={i}><FlowItemView item={item} refCount={preview.references.length} /></FlowSlot>
              ))}
            </div>
            <div
              style={{
                width: COLUMN_WIDTH,
                flexShrink: 0,
                overflow: 'hidden',
                // Same text width as the left column (and the measurement
                // pass), so a paragraph split across the two columns wraps at
                // exactly the measured line breaks on both sides.
                paddingRight: COLUMN_GAP / 2 + COLUMN_INNER_BORDER,
                overflowWrap: 'break-word',
                wordBreak: 'break-word',
              }}
            >
              {cols.right.map((item, i) => (
                <FlowSlot key={i}><FlowItemView item={item} refCount={preview.references.length} /></FlowSlot>
              ))}
            </div>
          </div>

          {/* Page number */}
          <div
            className="pb-2 pt-1 border-t border-gray-100 text-[7px] text-gray-400 text-center flex-shrink-0 mt-auto"
            style={{ paddingLeft: PAGE_PADDING_X, paddingRight: PAGE_PADDING_X }}
          >
            Page {pageIndex + 1} of {displayPages.length}
          </div>
        </div>
      ))}

      {/* Footer stats */}
      <div className="mx-4 px-6 pb-3 pt-1 flex gap-4 flex-wrap">
        {[
          { label: 'Sections', val: preview.sections.filter(s => s.level === 1).length },
          { label: 'Figures',  val: preview.figureCount },
          { label: 'Tables',   val: preview.tableCount },
          { label: 'Equations',val: preview.equationCount },
          { label: 'References', val: preview.referenceCount },
        ].map(({ label, val }) => (
          <div key={label} className="text-[7px] text-gray-400">
            <span className="font-semibold text-gray-600">{val}</span> {label}
          </div>
        ))}
      </div>
    </div>
  );
}

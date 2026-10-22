"""
Deterministic IEEE docx builder.

Opens the patched template (to inherit styles + page layout), clears the body,
then rebuilds all content from the DocumentModel.  No AI. No inference.
Every formatting decision is encoded in the DocumentModel JSON.
"""
from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Callable

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from PIL import Image

from engine.renderer import styles as S
from engine.schema import (
    Block,
    DocumentMetadata,
    DocumentModel,
    EquationBlock,
    FigureBlock,
    HeadingBlock,
    ListBlock,
    ParagraphBlock,
    Reference,
    TableBlock,
)

TEMPLATE_PATH = Path(__file__).parent.parent.parent.parent / "templates" / "ieee_template.docx"

# Inline citation anchor, e.g. "[CITE 3]" — resolved to an IEEE bracket "[3]".
# Case-insensitive; tolerates extra spaces like "[cite  3]".
_CITE_RE = re.compile(r"\[\s*CITE\s+(\d+)\s*\]", re.IGNORECASE)

# Extracts the trailing number from an anchor like "FIG 2", "WIDE-FIG 2",
# "[TABLE 1]", "WIDE-TABLE 1" — a plain str.replace("FIG ", "") breaks on the
# WIDE- prefixed forms (leaves "WIDE-2" in the caption instead of "2"), so
# captions pull just the digits regardless of anchor shape.
_ANCHOR_NUM_RE = re.compile(r"(\d+)")


def _anchor_number(anchor: str) -> str:
    m = _ANCHOR_NUM_RE.search(anchor)
    return m.group(1) if m else anchor


_ROMAN_NUMERALS = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
    (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
    (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]


def _to_roman(n: int) -> str:
    result = []
    for value, symbol in _ROMAN_NUMERALS:
        count, n = divmod(n, value)
        result.append(symbol * count)
    return "".join(result)


def _anchor_roman(anchor: str) -> str:
    """IEEE table numbers are Roman numerals ("TABLE I", not "TABLE 1")."""
    digits = _anchor_number(anchor)
    return _to_roman(int(digits)) if digits.isdigit() else digits


def _normalize_text(text: str) -> str:
    """Collapse embedded newlines (e.g. from text pasted out of a PDF, which
    hard-wraps every line) to spaces. python-docx turns a literal "\\n" in run
    text into a hard line break (<w:br/>), and with paragraph justification
    Word then force-justifies each of those pasted-in lines individually,
    stretching a few words across the full column width. The browser preview
    already collapses "\\n" to whitespace by default (plain HTML text-flow),
    so this keeps the docx matching what was always shown there."""
    return re.sub(r"\s*\n\s*", " ", text).strip()


def _fit_picture_size(img_path: Path, max_width_in: float, max_height_in: float) -> tuple[float, float] | None:
    """Compute (width_in, height_in) that fits the image inside the given box while
    preserving its aspect ratio. Returns None if the image can't be read (caller
    should fall back to width-only sizing)."""
    try:
        with Image.open(img_path) as img:
            px_w, px_h = img.size
    except Exception:
        return None
    if px_w <= 0 or px_h <= 0:
        return None

    aspect = px_h / px_w
    width_in = max_width_in
    height_in = width_in * aspect
    if height_in > max_height_in:
        height_in = max_height_in
        width_in = height_in / aspect
    return width_in, height_in


def _make_sect_pr(cols: int, continuous: bool = True) -> OxmlElement:
    """Build a w:sectPr element using the template's exact pt-notation values."""
    sp = OxmlElement("w:sectPr")

    if continuous:
        t = OxmlElement("w:type")
        t.set(qn("w:val"), "continuous")
        sp.append(t)

    pg = OxmlElement("w:pgSz")
    pg.set(qn("w:w"), S.PAGE_W_PT)
    pg.set(qn("w:h"), S.PAGE_H_PT)
    pg.set(qn("w:code"), S.PAGE_CODE)
    sp.append(pg)

    pm = OxmlElement("w:pgMar")
    pm.set(qn("w:top"),    S.MARGIN_TOP)
    pm.set(qn("w:right"),  S.MARGIN_RIGHT)
    pm.set(qn("w:bottom"), S.MARGIN_BOTTOM)
    pm.set(qn("w:left"),   S.MARGIN_LEFT)
    pm.set(qn("w:header"), S.MARGIN_HEADER)
    pm.set(qn("w:footer"), S.MARGIN_FOOTER)
    pm.set(qn("w:gutter"), S.MARGIN_GUTTER)
    sp.append(pm)

    cl = OxmlElement("w:cols")
    if cols > 1:
        cl.set(qn("w:num"), str(cols))
        cl.set(qn("w:space"), S.COL_SPACE_2)
    else:
        cl.set(qn("w:space"), S.COL_SPACE_1)
    sp.append(cl)

    dg = OxmlElement("w:docGrid")
    dg.set(qn("w:linePitch"), S.DOC_GRID_PITCH)
    sp.append(dg)

    return sp


def _strip_table_borders(table) -> None:
    """Remove all visible borders so the layout box is invisible on the page."""
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "nil")
        borders.append(el)
    tbl_pr.append(borders)


def _suppress_list_numbering(paragraph) -> None:
    """Turn off the paragraph style's automatic list numbering.

    The Golden template's "figure caption" style carries <w:numPr> with a
    numbered list that Word renders as "Fig. N." before the paragraph text,
    and the heading styles do the same ("I.", "A.", "1)"). The builder writes
    every label itself from the document model — the engine makes no
    numbering decisions of its own — so leaving the style numbering on
    doubled them up ("II. II. RELATED WORK", "Fig. 1. Fig. 1. ...",
    "[1] [1] M. Chen ...") or put a figure label on a table caption
    ("Fig. 1. TABLE I ..."). Every paragraph in those styles — headings,
    captions, references — calls this.

    Setting numId to 0 is the OOXML way to say "no numbering" for this
    paragraph, overriding the style without altering the style itself and
    without duplicating its formatting.
    get_or_add_numPr() inserts <w:numPr> at its schema position in <w:pPr>,
    so it stays valid even when alignment etc. were set first.
    """
    num_pr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
    num_pr.get_or_add_numId().val = 0


def _set_table_layout_fixed(table) -> None:
    """Force fixed column widths instead of Word auto-fitting to content."""
    tbl_pr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)


def _set_table_width_dxa(table, col_widths_dxa: list[int]) -> None:
    """Authoritatively set the table's width in twips (dxa).

    python-docx's `cell.width = ...` only rewrites each cell's `w:tcW` — it
    never touches `w:tblGrid` or the table-level `w:tblW`. With `tblLayout
    type="fixed"`, Word uses `tblGrid`/`tblW` (not `tcW`) to lay out the
    table, so leaving them at their template-inherited "full page width"
    defaults makes Word render the box far wider than the narrow column the
    cell width implies — which, combined with paragraph-level JUSTIFY on
    short text, produces the huge inter-word gaps seen in the abstract box.
    Both must be rewritten to match `cell.width` for the two to agree.
    """
    total_dxa = sum(col_widths_dxa)

    tbl_pr = table._tbl.tblPr
    tblw = tbl_pr.find(qn("w:tblW"))
    if tblw is None:
        tblw = OxmlElement("w:tblW")
        tbl_pr.append(tblw)
    tblw.set(qn("w:w"), str(total_dxa))
    tblw.set(qn("w:type"), "dxa")

    grid = table._tbl.find(qn("w:tblGrid"))
    if grid is None:
        grid = OxmlElement("w:tblGrid")
        table._tbl.insert(0, grid)
    for gc in list(grid):
        grid.remove(gc)
    for w in col_widths_dxa:
        gc = OxmlElement("w:gridCol")
        gc.set(qn("w:w"), str(w))
        grid.append(gc)


class DocxBuilder:
    def __init__(
        self,
        storage_base: Path,
        output_dir: Path,
        math_images: dict[str, Path],
    ) -> None:
        self.storage_base = storage_base
        self.output_dir = output_dir
        self.math_images = math_images   # anchor (e.g. "EQ 1") → png path

        # Open template to inherit all styles
        self.doc = Document(str(TEMPLATE_PATH))
        body = self.doc.element.body

        # Clear body content; replace with a clean 2-col body sectPr.
        # This final sectPr governs the LAST section — the 2-column body that
        # starts at the abstract. It must be marked continuous: with no w:type
        # OOXML defaults to "nextPage", which made Word begin that section on a
        # fresh page, leaving the title/author block alone on page 1 with the
        # abstract and everything after it pushed to page 2.
        for child in list(body):
            body.remove(child)
        body.append(_make_sect_pr(2, continuous=True))

        # Section-break state: we start in the 1-col title section
        self._in_two_col = False

        # Number of references available, for validating [CITE n] anchors.
        # Set in build(); anchors outside 1..n render visibly as "[?]".
        self._num_refs = 0

    # ── Public entry point ────────────────────────────────────────────────────

    def build(self, model: DocumentModel) -> Document:
        self._num_refs = len(model.references) if model.references else 0
        self._render_header(model.metadata)
        self._end_title_section()           # transition: 1-col → 2-col body
        self._render_abstract_and_keywords(model.metadata)
        for block in model.blocks:
            self._render_block(block)
        if model.references:
            self._render_references(model.references)
        return self.doc

    # ── Header (title, authors, abstract, keywords) ───────────────────────────

    def _render_header(self, meta: DocumentMetadata) -> None:
        # Title
        p = self.doc.add_paragraph(meta.title, style=S.PAPER_TITLE)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        # Conference (optional subtitle)
        if meta.conference:
            p = self.doc.add_paragraph(meta.conference, style=S.PAPER_SUBTITLE)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        # Authors sit side by side in rows of up to AUTHORS_PER_ROW, each author
        # in their own column: name, department, institution, city/country,
        # e-mail stacked one per line (fields that don't apply are skipped).
        # A borderless table gives true side-by-side columns; a blank paragraph
        # between rows separates one row of authors from the next.
        aff_by_key = {aff.key: aff for aff in meta.affiliations}
        AUTHORS_PER_ROW = 3

        def author_lines(author) -> list[str]:
            affs = [aff_by_key[key] for key in author.affiliation_refs if key in aff_by_key]
            lines = [author.name]
            for aff in affs:
                if aff.department:
                    lines.append(aff.department)
            for aff in affs:
                if aff.institution:
                    lines.append(aff.institution)
            for aff in affs:
                if aff.city and aff.country:
                    lines.append(f"{aff.city}, {aff.country}")
                elif aff.country:
                    lines.append(aff.country)
                elif aff.city:
                    lines.append(aff.city)
            if author.email:
                lines.append(author.email)
            return lines

        authors = meta.authors
        rows = [authors[i:i + AUTHORS_PER_ROW] for i in range(0, len(authors), AUTHORS_PER_ROW)]

        for row_idx, row_authors in enumerate(rows):
            n_cols = len(row_authors)
            table = self.doc.add_table(rows=1, cols=n_cols)
            table.autofit = False
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            _strip_table_borders(table)
            _set_table_layout_fixed(table)

            col_width = Inches(S.FULL_WIDTH_IN / n_cols)
            for col in table.columns:
                col.width = col_width
            col_width_dxa = int(S.FULL_WIDTH_IN / n_cols * 1440)
            _set_table_width_dxa(table, [col_width_dxa] * n_cols)

            for cell, author in zip(table.rows[0].cells, row_authors):
                cell.width = col_width
                lines = author_lines(author)

                first_para = cell.paragraphs[0]
                first_para.style = self.doc.styles[S.AUTHOR]
                first_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
                first_para.text = lines[0]

                for line in lines[1:]:
                    lp = cell.add_paragraph(line, style=S.AFFILIATION)
                    lp.alignment = WD_ALIGN_PARAGRAPH.CENTER

            # Gap paragraph after every row — separates rows from each other,
            # and separates the last row from whatever content follows.
            gap = self.doc.add_paragraph()
            gap.paragraph_format.space_after = Pt(12)

    def _render_abstract_and_keywords(self, meta: DocumentMetadata) -> None:
        """Abstract + Index Terms, confined to the left column's width so they sit
        at the top of the first column and let Introduction continue directly
        beneath them in that same column (standard IEEE layout) — not stretched
        full-width and not isolated in their own section/box."""
        box = self.doc.add_table(rows=1, cols=1)
        box.autofit = False
        box.alignment = WD_TABLE_ALIGNMENT.LEFT
        cell = box.rows[0].cells[0]
        cell.width = Inches(S.COL_WIDTH_IN)
        _strip_table_borders(box)
        _set_table_layout_fixed(box)
        _set_table_width_dxa(box, [int(S.COL_WIDTH_IN * 1440)])

        # docx creates one empty paragraph in a new cell; reuse it for Abstract.
        abstract_para = cell.paragraphs[0]
        abstract_para.style = self.doc.styles[S.ABSTRACT]
        abstract_para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        run = abstract_para.add_run("Abstract—")
        run.bold = True
        run.italic = True
        abstract_para.add_run(_normalize_text(meta.abstract))

        # Keywords
        kw_para = cell.add_paragraph(style=S.KEYWORDS)
        kw_para.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        run = kw_para.add_run("Index Terms—")
        run.bold = True
        run.italic = True
        kw_para.add_run(_normalize_text(", ".join(meta.keywords)))

    # ── Section break helpers ─────────────────────────────────────────────────

    def _end_title_section(self) -> None:
        """Insert the inline sectPr that terminates the 1-col title area."""
        self._add_section_break_para(cols=1)
        self._in_two_col = True

    def _add_section_break_para(self, cols: int) -> None:
        """Empty paragraph whose pPr/sectPr terminates the current section with `cols` columns."""
        para = self.doc.add_paragraph()
        pPr = para._p.get_or_add_pPr()
        pPr.append(_make_sect_pr(cols, continuous=True))

    def _enter_wide(self) -> None:
        """Switch from 2-col → 1-col for a full-width element."""
        if self._in_two_col:
            self._add_section_break_para(cols=2)
            self._in_two_col = False

    def _exit_wide(self) -> None:
        """Switch back from 1-col → 2-col after the full-width element."""
        self._add_section_break_para(cols=1)
        self._in_two_col = True

    # ── Block dispatcher ──────────────────────────────────────────────────────

    def _render_block(self, block: Block) -> None:
        match block.type:
            case "paragraph":
                self._render_paragraph(block)       # type: ignore[arg-type]
            case "heading":
                self._render_heading(block)          # type: ignore[arg-type]
            case "figure":
                self._render_figure(block)           # type: ignore[arg-type]
            case "wide_figure":
                self._render_wide_figure(block)      # type: ignore[arg-type]
            case "table":
                self._render_table(block)            # type: ignore[arg-type]
            case "wide_table":
                self._render_wide_table(block)       # type: ignore[arg-type]
            case "equation":
                self._render_equation(block)         # type: ignore[arg-type]
            case "list":
                self._render_list(block)             # type: ignore[arg-type]

    # ── Individual renderers ──────────────────────────────────────────────────

    def _render_paragraph(self, block: ParagraphBlock) -> None:
        p = self.doc.add_paragraph(style=S.BODY_TEXT)
        p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        if block.indent:
            p.paragraph_format.first_line_indent = Pt(12)
        self._add_text_with_citations(p, block.text)

    def _add_text_with_citations(self, para, text: str) -> None:
        """Append `text` to `para`, converting [CITE n] anchors into IEEE
        in-text citation brackets [n]. An anchor whose number has no matching
        reference renders as "[?]" so the problem is visible in the output.
        Text between anchors is emitted verbatim aside from newline collapsing
        (see `_normalize_text`)."""
        text = _normalize_text(text)
        pos = 0
        for m in _CITE_RE.finditer(text):
            if m.start() > pos:
                para.add_run(text[pos:m.start()])
            n = int(m.group(1))
            valid = 1 <= n <= self._num_refs
            para.add_run(f"[{n}]" if valid else "[?]")
            pos = m.end()
        if pos < len(text):
            para.add_run(text[pos:])

    def _render_heading(self, block: HeadingBlock) -> None:
        style = {1: S.HEADING_1, 2: S.HEADING_2, 3: S.HEADING_3}[block.level]
        # IEEE heading labels — "II. TITLE", "A. Title", "1) Title" — matching
        # the live preview. The model carries the numbering explicitly, so the
        # template style's own auto-numbering is switched off below.
        label = ""
        if block.numbering:
            label = f"{block.numbering}) " if block.level == 3 else f"{block.numbering}. "
        p = self.doc.add_paragraph(style=style)
        _suppress_list_numbering(p)
        if block.level == 1:
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(f"{label}{block.text.upper()}")
        else:
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            run = p.add_run(f"{label}{block.text}")
            run.italic = True

    def _render_figure(self, block: FigureBlock) -> None:
        img_path = self.storage_base / block.image_ref
        if img_path.exists():
            para = self.doc.add_paragraph()
            para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = para.add_run()
            fitted = _fit_picture_size(img_path, S.COL_WIDTH_IN, S.MAX_FIGURE_HEIGHT_IN)
            if fitted:
                width_in, height_in = fitted
                run.add_picture(str(img_path), width=Inches(width_in), height=Inches(height_in))
            else:
                run.add_picture(str(img_path), width=Inches(S.COL_WIDTH_IN))
        else:
            p = self.doc.add_paragraph(f"[IMAGE NOT FOUND: {block.image_ref}]", style=S.BODY_TEXT)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        cap = self.doc.add_paragraph(style=S.FIGURE_CAPTION)
        _suppress_list_numbering(cap)   # the label is written explicitly below
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.add_run(f"Fig. {_anchor_number(block.anchor)}. ").bold = True
        cap.add_run(block.caption)

    def _render_wide_figure(self, block: FigureBlock) -> None:
        self._enter_wide()
        img_path = self.storage_base / block.image_ref
        if img_path.exists():
            para = self.doc.add_paragraph()
            para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = para.add_run()
            fitted = _fit_picture_size(img_path, S.FULL_WIDTH_IN, S.MAX_FIGURE_HEIGHT_IN)
            if fitted:
                width_in, height_in = fitted
                run.add_picture(str(img_path), width=Inches(width_in), height=Inches(height_in))
            else:
                run.add_picture(str(img_path), width=Inches(S.FULL_WIDTH_IN))
        else:
            p = self.doc.add_paragraph(f"[IMAGE NOT FOUND: {block.image_ref}]", style=S.BODY_TEXT)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER

        cap = self.doc.add_paragraph(style=S.FIGURE_CAPTION)
        _suppress_list_numbering(cap)   # the label is written explicitly below
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.add_run(f"Fig. {_anchor_number(block.anchor)}. ").bold = True
        cap.add_run(block.caption)
        self._exit_wide()

    def _render_table(self, block: TableBlock) -> None:
        if not block.rows:
            return

        # Caption above the table (IEEE convention: table caption before table).
        # The shared "figure caption" style auto-numbers as "Fig. N." — suppress
        # that here so the caption reads "TABLE I", not "Fig. 1. TABLE I".
        cap = self.doc.add_paragraph(style=S.FIGURE_CAPTION)
        _suppress_list_numbering(cap)
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.add_run(f"TABLE {_anchor_roman(block.anchor)}").bold = True
        cap.add_run(f"  {block.caption}")

        tbl = self.doc.add_table(rows=len(block.rows), cols=len(block.rows[0]))
        tbl.style = "Normal Table"
        self._apply_table_borders(tbl)
        for r_idx, row_data in enumerate(block.rows):
            row = tbl.rows[r_idx]
            is_head = block.header_row and r_idx == 0
            for c_idx, cell_text in enumerate(row_data):
                cell = row.cells[c_idx]
                # Write cell text with real line breaks for any manual newlines
                # the user typed (Enter/Shift+Enter in the grid editor).
                para = cell.paragraphs[0]
                lines = cell_text.split("\n")
                para.add_run(lines[0])
                for extra in lines[1:]:
                    run = para.add_run()
                    run.add_break()
                    run.add_text(extra)
                style = S.TABLE_COL_HEAD if is_head else S.TABLE_COPY
                try:
                    para.style = style
                except KeyError:
                    pass  # style not in template — leave as-is
                # Set alignment AFTER style so the paragraph style can't reset
                # it. Header cells are always centered; body cells follow the
                # table's center flag (default True) — matches the preview.
                para.alignment = (
                    WD_ALIGN_PARAGRAPH.CENTER
                    if (is_head or block.center)
                    else WD_ALIGN_PARAGRAPH.LEFT
                )

    @staticmethod
    def _apply_table_borders(tbl) -> None:
        """Add thin borders to every cell (IEEE standard table look)."""
        from docx.oxml import OxmlElement
        tbl_pr = tbl._tbl.tblPr
        tbl_borders = OxmlElement("w:tblBorders")
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            border = OxmlElement(f"w:{side}")
            border.set(qn("w:val"), "single")
            border.set(qn("w:sz"), "4")
            border.set(qn("w:space"), "0")
            border.set(qn("w:color"), "000000")
            tbl_borders.append(border)
        tbl_pr.append(tbl_borders)

    def _render_wide_table(self, block: TableBlock) -> None:
        self._enter_wide()
        self._render_table(block)
        self._exit_wide()

    @staticmethod
    def _png_width_in(img_path: Path) -> float | None:
        """Natural display width of an equation PNG in inches = pixel width ÷ the
        image's stored DPI (matplotlib writes 300 DPI). Returns None if unreadable."""
        try:
            with Image.open(img_path) as img:
                px_w = img.size[0]
                dpi = img.info.get("dpi", (300, 300))[0] or 300
        except Exception:
            return None
        if px_w <= 0:
            return None
        return px_w / float(dpi)

    def _render_equation(self, block: EquationBlock) -> None:
        img_path = self.math_images.get(block.anchor)
        if img_path and img_path.exists():
            para = self.doc.add_paragraph(style=S.EQUATION)
            para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = para.add_run()
            # Insert the equation PNG at its NATURAL size (pixel dimensions ÷
            # render DPI), so an 11pt equation stays 11pt instead of being
            # force-scaled to a fixed column fraction — that fixed width shrank
            # wide equations down until the glyphs looked tiny. Only clamp width
            # if the natural size would overflow the column.
            max_width_in = S.COL_WIDTH_IN * (1.0 if not block.inline else 0.4)
            natural_in = self._png_width_in(img_path)
            if natural_in and natural_in <= max_width_in:
                run.add_picture(str(img_path), width=Inches(natural_in))
            else:
                run.add_picture(str(img_path), width=Inches(max_width_in))
        else:
            # Fallback: plain text LaTeX
            p = self.doc.add_paragraph(style=S.EQUATION)
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.add_run(block.latex)

        # Equation number (right-aligned)
        eq_num = _anchor_number(block.anchor)
        p = self.doc.add_paragraph(style=S.EQUATION)
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p.add_run(f"({eq_num})")

    def _render_list(self, block: ListBlock) -> None:
        for n, item in enumerate(block.items, start=1):
            if block.style == "bullet":
                p = self.doc.add_paragraph(style=S.BULLET_LIST)
            else:
                # The bullet style numbers itself, but there is no numbered-list
                # style in the template, so the "1." label is written here.
                # Hanging indent: the label sits in the indent and the tab after
                # it jumps to the text edge, so wrapped lines align with the
                # first line's text rather than under the number.
                p = self.doc.add_paragraph(style=S.BODY_TEXT)
                p.paragraph_format.left_indent = Pt(18)
                p.paragraph_format.first_line_indent = Pt(-12)
                p.add_run(f"{n}.\t")
            self._add_text_with_citations(p, item)

    # ── References ────────────────────────────────────────────────────────────

    def _render_references(self, refs: list[Reference]) -> None:
        # Section heading
        p = self.doc.add_paragraph(style=S.HEADING_1)
        _suppress_list_numbering(p)   # IEEE leaves REFERENCES unnumbered
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.add_run("REFERENCES")

        for ref in refs:
            p = self.doc.add_paragraph(style=S.REFERENCES)
            _suppress_list_numbering(p)   # the [key] is written explicitly below
            p.paragraph_format.left_indent = Pt(14)
            p.paragraph_format.first_line_indent = Pt(-14)  # hanging indent
            authors_str = ", ".join(ref.authors)
            p.add_run(f"[{ref.key}] ").bold = True
            parts = [authors_str, f'"{ref.title}"']
            if ref.venue:
                parts.append(f"in {ref.venue}")
            if ref.volume:
                parts.append(f"vol. {ref.volume}")
            if ref.issue:
                parts.append(f"no. {ref.issue}")
            if ref.pages:
                parts.append(f"pp. {ref.pages}")
            if ref.year:
                parts.append(str(ref.year))
            if ref.doi:
                parts.append(f"doi: {ref.doi}")
            p.add_run(", ".join(parts) + ".")

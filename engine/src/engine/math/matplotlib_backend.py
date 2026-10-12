"""Math backend v1: matplotlib mathtext → 300 DPI transparent PNG."""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.mathtext import MathTextParser
from matplotlib.patches import PathPatch
from matplotlib.path import Path as MplPath


class MatplotlibMathBackend:
    """
    Renders LaTeX-like math via matplotlib's mathtext engine.
    Does not require a TeX installation.

    mathtext only handles single-line math, so multi-row environments
    (cases, matrices, aligned, ...) are laid out here instead: every cell is
    still typeset by mathtext, and this module positions the rows/columns and
    draws the stretchy delimiters around them. See `_render_layout`.
    """

    DPI = 300

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def render(self, latex: str, inline: bool = False) -> Path:
        """Render `latex` to a transparent PNG and return its path."""
        # Display equations render a bit larger so they read clearly in the
        # two-column layout; inline stays close to body text size.
        fontsize = 10 if inline else 13
        out_path = self.output_dir / f"eq_{uuid.uuid4().hex[:8]}.png"

        if _BEGIN_RE.search(latex):
            _render_layout(latex.strip().strip("$"), fontsize, out_path, self.DPI)
            return out_path

        expression = latex.strip()
        if not expression.startswith("$"):
            expression = f"${expression}$"

        # Draw the expression as a figure-level text artist (NOT inside an
        # axes that fills the whole canvas — that stopped bbox_inches="tight"
        # from cropping, leaving the glyph as a tiny mark on a large canvas,
        # which then got clamped to column width and looked shrunken). Start
        # from a tiny figure and let tight bbox grow it to exactly the text.
        fig = plt.figure(figsize=(0.01, 0.01))
        fig.patch.set_alpha(0)
        fig.text(0, 0, expression, fontsize=fontsize, color="black")
        _save(fig, out_path, self.DPI)
        return out_path


def _save(fig: Figure, out_path: Path, dpi: int) -> None:
    fig.savefig(
        str(out_path),
        dpi=dpi,
        bbox_inches="tight",
        transparent=True,
        pad_inches=0.02,
    )
    plt.close(fig)


# ── Environment layout ───────────────────────────────────────────────────────
# All geometry below is in points, measured at 72 dpi so 1 unit == 1 pt, and
# converted to inches only when drawing (artists use fig.dpi_scale_trans).

_BEGIN_RE = re.compile(r"\\begin\{([A-Za-z]+\*?)\}")
_PARSER = MathTextParser("path")


@dataclass(frozen=True)
class _EnvSpec:
    align: str              # "l"/"c"/"r" per column (repeated), "rl" = aligned pairs, "" = from array colspec
    left: str | None        # opening delimiter drawn to the content's height
    right: str | None
    colsep: float = 1.0     # gap between columns, in em


_ENVS: dict[str, _EnvSpec] = {
    "cases":    _EnvSpec("l", "{", None),
    "dcases":   _EnvSpec("l", "{", None),
    "rcases":   _EnvSpec("l", None, "}"),
    "matrix":   _EnvSpec("c", None, None, 0.8),
    "pmatrix":  _EnvSpec("c", "(", ")", 0.8),
    "bmatrix":  _EnvSpec("c", "[", "]", 0.8),
    "Bmatrix":  _EnvSpec("c", "{", "}", 0.8),
    "vmatrix":  _EnvSpec("c", "|", "|", 0.8),
    "Vmatrix":  _EnvSpec("c", "‖", "‖", 0.8),
    "array":    _EnvSpec("", None, None, 0.8),
    "aligned":  _EnvSpec("rl", None, None),
    "align":    _EnvSpec("rl", None, None),
    "align*":   _EnvSpec("rl", None, None),
    "split":    _EnvSpec("rl", None, None),
    "gathered": _EnvSpec("c", None, None),
    "gather":   _EnvSpec("c", None, None),
    "gather*":  _EnvSpec("c", None, None),
}


@dataclass
class _Box:
    width: float
    ascent: float           # above the baseline
    descent: float          # below the baseline
    draw: Callable[[Figure, float, float], None]   # (fig, x, baseline)


_RELATION_END = re.compile(
    r"(=|<|>|:=|\\(?:leq?|geq?|neq?|ne|approx|equiv|sim|simeq|cong|propto|"
    r"to|rightarrow|leftarrow|Rightarrow|Leftarrow|iff|in|subset|subseteq|mapsto))\s*$"
)
_BINARY_END = re.compile(r"(\+|-|\\(?:pm|mp|cdot|times|div|cup|cap))\s*$")


def _space_before_env(text: str, fs: float) -> float:
    """Space after a math run that ends in a relation/operator and is followed
    by an environment. mathtext drops it because the run is typeset on its
    own and nothing follows the operator there."""
    if _RELATION_END.search(text):
        return 5 / 18 * fs      # TeX's thick space (\;)
    if _BINARY_END.search(text):
        return 4 / 18 * fs      # TeX's medium space (\:)
    return 0.0


def _render_layout(expr: str, fontsize: float, out_path: Path, dpi: int) -> None:
    segments = _segments(expr)
    boxes = []
    for i, seg in enumerate(segments):
        box = _segment_box(seg, fontsize)
        nxt = segments[i + 1] if i + 1 < len(segments) else None
        if seg[0] == "math" and nxt is not None and nxt[0] == "env":
            box.width += _space_before_env(seg[1], fontsize)
        boxes.append(box)
    width = sum(b.width for b in boxes)
    ascent = max((b.ascent for b in boxes), default=0.0)
    descent = max((b.descent for b in boxes), default=0.0)

    fig = plt.figure(figsize=(max(width, 1.0) / 72, max(ascent + descent, 1.0) / 72))
    fig.patch.set_alpha(0)
    x = 0.0
    for box in boxes:
        box.draw(fig, x, descent)
        x += box.width
    _save(fig, out_path, dpi)


def _segments(expr: str) -> list[tuple]:
    """Split `expr` into plain-math runs and top-level environments."""
    segments: list[tuple] = []
    pos = 0
    while True:
        m = _BEGIN_RE.search(expr, pos)
        if not m:
            segments.append(("math", expr[pos:]))
            return segments
        segments.append(("math", expr[pos:m.start()]))
        name = m.group(1)
        start = m.end()

        colspec = ""
        if name == "array":
            cm = re.match(r"\s*\{([^}]*)\}", expr[start:])
            if cm:
                colspec = cm.group(1)
                start += cm.end()

        # Find the matching \end{name}, allowing the same env to nest.
        depth = 1
        pattern = re.compile(r"\\(begin|end)\{" + re.escape(name) + r"\}")
        for mm in pattern.finditer(expr, start):
            depth += 1 if mm.group(1) == "begin" else -1
            if depth == 0:
                segments.append(("env", name, colspec, expr[start:mm.start()]))
                pos = mm.end()
                break
        else:
            raise ValueError(f"missing \\end{{{name}}}")


def _segment_box(seg: tuple, fs: float) -> _Box:
    if seg[0] == "math":
        text = seg[1]
        # The empty group keeps TeX's spacing around a relation or operator
        # that ends up at the edge of a run — e.g. "A_i =" before a cases
        # block would otherwise lose the space after "=".
        return _math_box("{}" + text + "{}" if text.strip() else "", fs)
    _, name, colspec, body = seg
    return _env_box(name, colspec, body, fs)


def _math_box(s: str, fs: float) -> _Box:
    if not s.strip():
        return _Box(0.0, 0.0, 0.0, lambda fig, x, y: None)
    tex = f"${s}$"
    parsed = _PARSER.parse(tex, dpi=72, prop=FontProperties(size=fs))
    # For vector output, `height` is the full extent (ascent + depth).
    width, height, depth = parsed.width, parsed.height, parsed.depth

    def draw(fig: Figure, x: float, y: float) -> None:
        fig.text(
            x / 72, y / 72, tex,
            fontsize=fs, color="black",
            transform=fig.dpi_scale_trans, ha="left", va="baseline",
        )

    return _Box(width, height - depth, depth, draw)


def _split_cells(body: str) -> list[list[str]]:
    """Split an environment body into rows (\\\\) and cells (&) at brace depth 0."""
    rows: list[list[str]] = []
    row: list[str] = []
    cell: list[str] = []
    depth = 0
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\":
            if body[i + 1:i + 2] == "\\" and depth == 0:
                row.append("".join(cell))
                rows.append(row)
                row, cell = [], []
                i += 2
                spacing = re.match(r"\s*\[[^\]]*\]", body[i:])   # \\[4pt]
                if spacing:
                    i += spacing.end()
                continue
            # Copy a whole control sequence so \{ \} \& never count as syntax.
            tok = re.match(r"\\(?:[A-Za-z]+|.)", body[i:])
            token = tok.group(0) if tok else c
            cell.append(token)
            i += len(token)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == "&" and depth == 0:
            row.append("".join(cell))
            cell = []
            i += 1
            continue
        cell.append(c)
        i += 1
    row.append("".join(cell))
    rows.append(row)

    rows = [[re.sub(r"\\hline", "", cell).strip() for cell in r] for r in rows]
    if len(rows) > 1 and not any(rows[-1]):
        rows.pop()   # trailing \\ before \end{...}
    return rows


def _env_box(name: str, colspec: str, body: str, fs: float) -> _Box:
    spec = _ENVS.get(name)
    if spec is None:
        raise ValueError(f"unsupported environment: {name}")

    rows = _split_cells(body)
    ncols = max(len(r) for r in rows)
    pairs = spec.align == "rl"

    if pairs:
        aligns = ["r" if c % 2 == 0 else "l" for c in range(ncols)]
    elif spec.align:
        aligns = [spec.align] * ncols
    else:
        letters = [ch for ch in colspec if ch in "lcr"]
        aligns = [letters[c] if c < len(letters) else "c" for c in range(ncols)]

    cells = [
        [
            # In aligned pairs the right cell usually starts with a relation
            # ("&= b"); the leading {} gives it its normal left spacing.
            _math_box(("{}" + text) if pairs and c % 2 == 1 and text else text, fs)
            for c, text in enumerate(row + [""] * (ncols - len(row)))
        ]
        for row in rows
    ]

    col_widths = [max(r[c].width for r in cells) for c in range(ncols)]
    gaps = [
        (0.0 if c % 2 == 0 else 2.0 * fs) if pairs else spec.colsep * fs
        for c in range(ncols - 1)
    ]
    # A strut so rows of short cells still get a full line's height.
    row_asc = [max([0.7 * fs] + [b.ascent for b in r]) for r in cells]
    row_desc = [max([0.3 * fs] + [b.descent for b in r]) for r in cells]
    row_gap = 0.25 * fs

    content_w = sum(col_widths) + sum(gaps)
    content_h = sum(row_asc) + sum(row_desc) + row_gap * (len(cells) - 1)

    delim_w = {"|": 0.25, "‖": 0.4}
    left_w = delim_w.get(spec.left, 0.4) * fs if spec.left else 0.0
    right_w = delim_w.get(spec.right, 0.4) * fs if spec.right else 0.0
    delim_gap = 0.15 * fs
    width = (
        left_w + (delim_gap if spec.left else 0.0)
        + content_w
        + (delim_gap if spec.right else 0.0) + right_w
    )

    # Centre the block on the math axis (where "=" and "−" sit), not the
    # baseline, so it lines up with the run of math beside it.
    axis = 0.25 * fs
    top = axis + content_h / 2
    bottom = axis - content_h / 2
    overshoot = 0.1 * fs

    def draw(fig: Figure, x: float, baseline: float) -> None:
        y_top = baseline + top + overshoot
        y_bot = baseline + bottom - overshoot
        cx = x
        if spec.left:
            _draw_delim(fig, spec.left, cx, cx + left_w, y_bot, y_top, fs, mirror=False)
            cx += left_w + delim_gap

        y = baseline + top
        for r, row in enumerate(cells):
            row_base = y - row_asc[r]
            col_x = cx
            for c, box in enumerate(row):
                slack = col_widths[c] - box.width
                offset = {"l": 0.0, "c": slack / 2, "r": slack}[aligns[c]]
                box.draw(fig, col_x + offset, row_base)
                col_x += col_widths[c] + (gaps[c] if c < len(gaps) else 0.0)
            y = row_base - row_desc[r] - row_gap

        if spec.right:
            rx = cx + content_w + delim_gap
            _draw_delim(fig, spec.right, rx, rx + right_w, y_bot, y_top, fs, mirror=True)

    return _Box(width, top + overshoot, max(0.0, overshoot - bottom), draw)


def _draw_delim(
    fig: Figure, kind: str, x0: float, x1: float, yb: float, yt: float,
    fs: float, mirror: bool,
) -> None:
    """Draw a delimiter stretched to span yb..yt (points) between x0 and x1.

    Shapes are written as opening delimiters; `mirror` flips them horizontally
    for the closing side.
    """
    M, L, C = MplPath.MOVETO, MplPath.LINETO, MplPath.CURVE4
    xo, xi = (x0, x1) if not mirror else (x1, x0)   # outer edge, inner edge
    xm = (x0 + x1) / 2
    mid = (yb + yt) / 2
    r = (x1 - x0) / 2

    if kind in ("{", "}"):
        verts = [
            (xi, yt), (xm, yt), (xm, yt), (xm, yt - r),
            (xm, mid + r),
            (xm, mid), (xm, mid), (xo, mid),
            (xm, mid), (xm, mid), (xm, mid - r),
            (xm, yb + r),
            (xm, yb), (xm, yb), (xi, yb),
        ]
        codes = [M, C, C, C, L, C, C, C, C, C, C, L, C, C, C]
    elif kind in ("(", ")"):
        verts = [(xi, yt), (xo, yt - 0.1 * (yt - yb)), (xo, yb + 0.1 * (yt - yb)), (xi, yb)]
        codes = [M, C, C, C]
    elif kind in ("[", "]"):
        verts = [(xi, yt), (xo, yt), (xo, yb), (xi, yb)]
        codes = [M, L, L, L]
    elif kind == "|":
        verts = [(xm, yt), (xm, yb)]
        codes = [M, L]
    elif kind == "‖":
        verts = [(xm - r / 2, yt), (xm - r / 2, yb), (xm + r / 2, yt), (xm + r / 2, yb)]
        codes = [M, L, M, L]
    else:
        raise ValueError(f"unsupported delimiter: {kind}")

    path = MplPath([(vx / 72, vy / 72) for vx, vy in verts], codes)
    fig.add_artist(PathPatch(
        path, transform=fig.dpi_scale_trans, fill=False,
        edgecolor="black", linewidth=0.06 * fs,
        capstyle="round", joinstyle="round",
    ))

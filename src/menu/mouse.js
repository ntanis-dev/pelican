import {
  bodyHeight,
  frameCols,
  paneHeaderRows,
  sideBrandRows,
  sideFooterRows,
  tooSmall,
} from "./layout.js";
import { paneBox, paneModel, paneWindow } from "./pane.js";
import {
  sideWidth,
  sideLines,
  sideSpan,
  sideTop,
  treeRows,
  glyphsOf,
} from "./tree.js";
import { makeTheme } from "./theme.js";
import { modalLayout, paletteLayout, toastLayouts } from "./ui/overlays.js";
import { footerModel } from "./ui/chrome.js";
import { tabsModel } from "./ui/pane.js";

const at = (targets, x, y) =>
  targets.find(
    (target) => target.y === y && x >= target.x && x < target.x + target.width,
  );
export function hitTest(state, event) {
  const { x, y, kind, button } = event;
  if (
    tooSmall(state) ||
    x < 0 ||
    y < 0 ||
    x >= frameCols(state) ||
    y >= state.size.rows - 1
  )
    return null;
  if (state.splash) return kind === "press" ? { dismiss: true } : null;
  if (!["press", "wheel"].includes(kind)) return null;
  const theme = makeTheme({ color: state.color, glyphs: state.glyphs });
  if (state.modal) {
    const layout = modalLayout(state, theme);
    if (kind === "wheel")
      return {
        modalScroll: Math.max(
          0,
          Math.min(layout.max, layout.offset + event.delta),
        ),
      };
    return button === 0 ? (at(layout.targets, x, y) ?? null) : null;
  }
  if (state.palette) {
    if (kind === "wheel") return { paletteStep: event.delta };
    const layout = paletteLayout(state, theme);
    if (button !== 0) return null;
    return (
      at(layout.targets, x, y) ??
      (at([layout.close], x, y) ? { command: "escape" } : null)
    );
  }
  if (kind === "press") {
    if (button !== 0) return null;
    const toast = toastLayouts(state, theme).find(
      (t) =>
        x >= t.left &&
        x < t.left + t.width &&
        y >= t.top &&
        y < t.top + t.lines.length,
    );
    if (toast) return { toast: toast.id };
    if (y === state.size.rows - 2)
      return at(footerModel(state, glyphsOf(state)).targets, x, y) ?? null;
  }
  if (state.service.state !== "up") return null;
  const side = sideWidth(state),
    inSide = x < side;
  if (kind === "wheel") return { scroll: event.delta, side: inSide };
  if (inSide) {
    if (y === sideBrandRows - 2) return { command: "/" };
    if (y === bodyHeight(state) - 2) return { command: ":" };
    const cells = side - 3,
      rows = treeRows(state),
      view = sideLines(state, cells, {
        focused: state.focus === "side",
        g: theme.g,
        rows,
        span: sideSpan(state, cells, rows),
      });
    const room = Math.max(
        1,
        bodyHeight(state) - sideBrandRows - sideFooterRows,
      ),
      top = sideTop(view.lines.length, view.from, view.to, room),
      index = y - sideBrandRows;
    if (index < 0 || index >= room || x < 1 || x >= side - 1) return null;
    const id = view.owners[top + index],
      row = rows.find((r) => r.id === id);
    return id
      ? {
          select: id,
          ...(row?.node && x < 5 ? { node: true, open: !row.open } : {}),
        }
      : null;
  }
  const box = paneBox(state),
    model = paneModel(state),
    w = paneWindow(state, model, box),
    px = x - side - 3;
  if (px < 0 || px >= box.room.width) return null;
  const tab = at(tabsModel(model, box.room.width).targets, px, y);
  if (tab) return tab;
  const py = y - paneHeaderRows - model.head.length;
  if (py < 0 || py >= w.room) return null;
  const bodyY = py + w.top,
    target = at(model.targets[bodyY] ?? [], px, bodyY);
  if (target) return target;
  const fold = model.folds.find(
    (f) => bodyY >= f.line && bodyY < f.line + f.size,
  );
  return fold ? { foldKey: fold.key } : null;
}

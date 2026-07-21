# UX Review: Mobile Layer Selection on the Canvas

**Date:** 2026-07-16
**Status:** Review / recommendation — no code changes in this repo (the interactive
editor lives outside `morphareels-sdk`; this SDK carries the schema + headless tools
that document the editor's data model).

---

## 1. The reported bug

> "I can't select any layers in the mobile view — it keeps thinking I'm moving the
> background with two sequential taps."

Two independent failures are stacking:

### 1a. The background is an infinite, always-hit, draggable target

Since the unified canvas-background migration, the backdrop is a **regular
`image_layers[]` entry** with `pinned: true` + `is_background: true`
(`src/core/schemas.ts:154-158`, migration at `src/core/schemas.ts:1266`). Two
properties make it a gesture trap on touch:

1. **It is painted across the full canvas regardless of its own
   x/y/width/height** (`src/core/schemas.ts:155-157`). Every tap that misses
   another layer's hit-box lands on the background — it is a 100%-coverage hit
   target at the bottom of the z-stack.
2. Because the render ignores its x/y, **"moving" the background is a visual
   no-op**. The editor is spending the user's primary gesture mutating
   coordinates that change nothing on screen.

`pinned` layers already "refuse deletion / reorder from the UI + tools"
(`src/core/schemas.ts:157-158`) — but evidently not **selection or drag**. That's
the gap.

### 1b. No tap-vs-drag disambiguation (touch slop)

"Two sequential taps → background move" is the classic slop failure: tap #1 falls
through to the background and selects it; tap #2 lands with a few pixels of natural
finger jitter, the editor has no minimum-movement threshold before promoting
`pointerdown` to a drag, so the jitter becomes a background drag. Real layers on
top never get selected. Platform frameworks all gate drags behind a slop distance:

| Platform | Slop before a touch becomes a drag |
|---|---|
| Android (`ViewConfiguration.getScaledTouchSlop`) | 8 dp |
| Flutter (`kTouchSlop`) | 18 logical px (raised from 8 after complaints) |
| dnd-kit recommended touch sensor | 250 ms hold **or** distance, + 5 px tolerance |
| Web canvas editors (common guidance) | 8–10 CSS px |

A likely aggravator worth checking in the editor: mobile renders the 1080×1920
canvas at roughly 0.3× scale, so a fixed *canvas-space* threshold or hit-box
shrinks 3× in *screen* space. Hit-testing and slop must be computed in **screen
pixels**, not canvas pixels.

---

## 2. What other players do

Surveyed: CapCut, Canva mobile, Figma/FigJam (iPad), Procreate, Instagram
Stories/TikTok, InShot, Miro. Sources are official help centers where available;
third-party tutorials where not (CapCut and InShot publish no gesture reference).

| Product | Select | Move layer | Pan/zoom viewport | Long-press | Overlaps |
|---|---|---|---|---|---|
| **CapCut** | Tap clip in **timeline** (primary) or tap element in preview | 1-finger drag on selected element | Effectively none — pinch transforms the *content* | (unverified) | Timeline rows |
| **Canva mobile** | Tap element | Press-and-drag | 2-finger drag pans, pinch zooms | "Select multiple" (multi-select entry) | **Layers panel**; official advice: zoom in, then tap |
| **FigJam iPad** | Tap object | 1-finger drag on object | 1-finger drag on *empty* canvas pans; 2-finger always pans/zooms | Long-press + drag = **marquee** | Desktop only: right-click "Select layer" list |
| **Procreate** | **Layers panel only** (canvas never selects) | n/a (1 finger always paints) | 2-finger drag/pinch/twist | Eyedropper | Layers panel |
| **IG Stories / TikTok** | None — grab = manipulate | 1-finger drag | **No viewport at all** (canvas = screen) | Pin sticker / remove | n/a (few elements) |
| **InShot** | Tap element on preview | 1-finger drag | limited | — | Documented pain point: taps keep hitting the background video ("fat finger") |
| **Miro tablet** | Tap object | Long-tap object, then drag | 1-finger empty-canvas pan; 2-finger pan/zoom; opens **view-only by default** | Long-tap + drag = marquee | — |

Cross-cutting conventions:

- **Two fingers navigate, one finger acts on content.** The single strongest
  convention (Procreate, Concepts, Miro, FigJam). Figma's forum is full of users
  demanding exactly this — "In every iPad app with canvas navigation you pan/zoom
  with two fingers and select with one" — after FigJam tried auto-toggling
  pan/select and users hated it. **Never let a one-finger gesture ambiguously mean
  both "pan the world" and "move a layer" on the same target.**
- **The background/base video is the #1 documented mis-selection victim**
  (InShot's fat-finger problem, Canva's overlap complaints). Products that solve
  it either make the backdrop unselectable from canvas (Procreate: layers panel
  only) or route selection through a secondary surface (CapCut: timeline; Canva:
  layers panel).
- **Long-press → context menu is the sanctioned mobile "right-click"** (iOS HIG:
  touch-and-hold is the system trigger for context menus; default long-press
  duration 500 ms on both platforms). Whiteboard apps instead spend long-press on
  marquee/move (Miro, FigJam) — a choice, not a conflict: you get one long-press
  meaning per app.
- **"Tap again to cycle through stacked layers" has no grounded mobile
  precedent.** On touch, the documented overlap-disambiguation patterns are
  (a) a layers panel, (b) a "which layer?" list menu (Figma/Sketch desktop's
  right-click → Select layer, which ports naturally to a long-press menu), or
  (c) zoom in and tap (Canva's official advice).
- **Touch targets:** ≥ 44×44 pt (Apple HIG) / 48×48 dp (Material), independent of
  the visual size — enforced in *screen* space via invisible hit slop
  (React Native's `hitSlop` is the canonical mechanism).

---

## 3. Recommended gesture spec for Morpha mobile

The user's instinct — *"a press selects a layer and shows like a right-click
menu"* — is directionally right and matches platform convention. Full spec:

### Selection & movement
1. **Tap = select** the topmost *selectable* layer whose screen-space hit area
   contains the point. Expand every layer's hit area to at least 44 pt in screen
   space (invisible slop around small text/shape/curve layers). Among multiple
   candidates within slop, prefer the topmost in z-order, tie-break by nearest
   center.
2. **`is_background` / `pinned` layers are never canvas hit targets.** Tap on
   empty canvas or background = **deselect**, nothing else. Editing the backdrop
   goes through an explicit affordance (a "Background" chip when nothing is
   selected, or the layers sheet). Since the renderer ignores the backdrop's
   x/y/width/height anyway, background drag should not exist at all.
3. **One-finger drag starting on a layer = select + move that layer**, but only
   after crossing a slop threshold of ~10 screen px (or dnd-kit's 250 ms + 5 px
   tolerance recipe). Below slop and under ~300 ms → it's a tap, full stop. Two
   sequential taps must never synthesize a drag.
4. **Two-finger drag = pan, pinch = zoom, always** — even mid-gesture over a
   layer. If the canvas is fit-to-screen at 1×, one-finger empty-canvas pan is
   unnecessary; only enable panning when zoomed in, and prefer two-finger for it.

### Long-press (the "right-click")
5. **Long-press (500 ms, with haptic) on a layer = select + context menu**:
   Duplicate, Delete, Lock, Bring forward / Send backward, and — critically — a
   **"Layers here" section listing every layer under the finger** (thumbnail +
   name), the touch port of Figma/Sketch's right-click → Select layer. This is
   the overlap-disambiguation story, replacing the unprovable tap-to-cycle idea.
6. **Long-press on empty canvas** = the same menu scoped to canvas actions
   (Paste, Edit background, Select all).

### Supporting affordances
7. **Selected layer gets hit-test priority** — once selected, its body and
   handles win ties against overlapping siblings, so adjust-after-select is easy.
8. **Handles rendered ≥ 44 pt screen-space regardless of zoom level.**
9. **A mobile layers sheet** (bottom sheet listing the z-stack, tap to select,
   drag to reorder) as the guaranteed-success fallback — every surveyed product
   that handles overlaps well has one.
10. **Haptic feedback** on select and on long-press menu open.

### Engineering checklist for the editor (root-cause fixes, in priority order)
- [ ] Exclude `pinned` / `is_background` layers from canvas hit-testing and drag.
- [ ] Add touch slop: no drag until pointer moves > ~10 screen px from down-point;
      suppress the drag entirely for short still touches (that's a tap).
- [ ] Verify hit-testing converts touch coordinates through the current
      canvas scale/offset (screen → canvas), and compute slop + hit padding in
      **screen** pixels.
- [ ] `touch-action: none` on the canvas element + `setPointerCapture` on the
      active pointer, so the browser doesn't eat or reinterpret gestures.
- [ ] Add screen-space hit padding for small layers (44 pt minimum target).
- [ ] Long-press → context menu with "Layers here" list.

### SDK-side follow-ups (this repo, optional)
- Consider documenting in `imageLayerSchema` that `pinned` layers should also
  refuse *canvas selection and drag* (today the comment only promises they refuse
  deletion/reorder — `src/core/schemas.ts:157-158`).
- Consider having position-mutating tools (`update_layer` x/y, align/distribute,
  keyframe writers) warn or no-op on `is_background` layers, since the renderer
  ignores those fields — a silent no-op write is confusing for agents too.

---

## 4. Sources

- Canva Help: Moving elements; Finding and arranging layers; Design School "Pinch to zoom"
- Figma Help: FigJam for iPad; Select layers and objects; Figma forum threads on pan/select auto-toggling
- Procreate Handbook: Gestures; procreate.com/insight/2022/gestures
- Miro Help: Using Miro with a touchscreen; Tablet app; Working with objects
- Apple HIG: Touchscreen gestures; Context menus; Developer design tips (44 pt)
- Material Design: Touch targets (48 dp)
- Android `ViewConfiguration` docs (8 dp touch slop); Flutter `kTouchSlop` (18 lp)
- dnd-kit sensor docs (250 ms + 5 px touch recipe)
- MDN: Pointer events, `PointerEvent.width/height`
- Third-party (no official gesture docs exist): Envato Tuts+ / Alphr / VideoProc
  (CapCut), Filmora / TechBloat (InShot), Guiding Tech / Tom's Guide (IG Stories)

*Caveat: several official help pages (Figma, Procreate) blocked direct fetching;
their entries are grounded in search excerpts of the official pages. CapCut and
InShot details are third-party-sourced throughout.*

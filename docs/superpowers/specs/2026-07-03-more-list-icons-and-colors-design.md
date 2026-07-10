# More list icons & colors — Design

**Date:** 2026-07-03
**Status:** Approved (design + visual preview)

## Problem

Lists can be personalized with an icon + color, but the sets are small: **16 icons** and **7 colors**. Users want more variety so a list reads at a glance and feels theirs.

## Solution

Expand to **46 icons** (+30) and **15 colors** (+8). The system is fully derived from two sources of truth in `src/lib/list-icons.ts`, so the picker UI, TypeScript unions, and zod validation all extend automatically. **No DB migration and no API-route changes** (the `lists.icon`/`lists.color` columns are free-form nullable `TEXT`; the zod enums are generated from the arrays).

### Colors: 7 → 15

`LIST_COLORS` is reordered around the hue wheel (cosmetic — the picker renders in array order; stored values are names, so reordering is safe) and the 8 new tones are added:

Final array order:
`red, orange, amber, yellow, lime, emerald, teal, cyan, blue, indigo, violet, fuchsia, rose, slate, stone`

New tokens (add to **both** the `:root` and `.dark` blocks in `app/globals.css`), tuned to the existing lightness/chroma bands (light ≈ L 0.62 / C 0.16–0.20; dark ≈ L 0.72 / C 0.14–0.18; neutrals ≈ C 0.02):

| name | light | dark |
|---|---|---|
| red | `oklch(0.60 0.20 27)` | `oklch(0.70 0.18 27)` |
| orange | `oklch(0.66 0.17 55)` | `oklch(0.74 0.15 55)` |
| amber | `oklch(0.72 0.15 80)` | `oklch(0.80 0.14 80)` |
| yellow | `oklch(0.76 0.14 100)` | `oklch(0.83 0.13 100)` |
| teal | `oklch(0.64 0.12 190)` | `oklch(0.74 0.11 190)` |
| indigo | `oklch(0.55 0.17 268)` | `oklch(0.66 0.16 268)` |
| fuchsia | `oklch(0.62 0.22 322)` | `oklch(0.72 0.19 322)` |
| stone (warm neutral) | `oklch(0.55 0.02 70)` | `oklch(0.65 0.02 70)` |

Existing 7 tokens are unchanged. Per-type defaults (`defaultColorFor`) are unchanged.

### Icons: 16 → 46

Add 30 lucide-react icons — import each and register in `LIST_ICONS` (appended after the existing 16, preserving current order). All 30 are confirmed present in the installed `lucide-react@0.470.0` (their real geometry was extracted for the approved preview).

New icons (grouped for intent; registered in this order):
- **Food & drink:** Coffee, Wine, Cake, Apple
- **Travel & outdoors:** Car, MapPin, Mountain, Tent, Fuel
- **Pets & family:** Dog, Cat, Baby
- **Health:** HeartPulse, Stethoscope
- **Work & study:** GraduationCap, Laptop, Calendar
- **Home & garden:** Shirt, Leaf, Flower2, Hammer
- **Deliveries & goals:** Package, Truck, Rocket
- **Hobbies:** Music, Camera, Gamepad2, Palette, Star, Lightbulb

Per-type defaults (`defaultIconFor`) are unchanged.

## Architecture / edit points

1. `src/lib/list-icons.ts`
   - Imports (lines ~1–19): add the 30 new lucide names.
   - `LIST_ICONS` object: add 30 keys.
   - `LIST_COLORS` array: reorder + add 8 names.
2. `app/globals.css`
   - `:root` block: add 8 `--list-<name>` tokens (light).
   - `.dark` block: add the same 8 (dark).

`ListIconName`, `LIST_ICON_NAMES`, `ListColor`, the zod `listIconEnum`/`listColorEnum` (`src/schemas/lists.ts`), and `components/IconColorPicker.tsx` all derive with no edits.

## Not doing
- No DB migration (columns are free-form `TEXT`, nullable).
- No API-route or schema-file edits (zod enums derive from the arrays).
- No change to per-type defaults or to existing color values/icons.

## Testing
`__tests__/unit/list-colors-css.test.ts` — the one real risk is adding a `LIST_COLORS` name but forgetting its `--list-<name>` token in one theme (silent broken rendering in that theme). The test imports `LIST_COLORS`, reads `app/globals.css`, and asserts every color name has a `--list-<name>:` definition **at least twice** (light + dark). Icon-import errors are caught by `tsc`/`next build`. (Repo convention: pure-function/pure-data vitest, no DOM.)

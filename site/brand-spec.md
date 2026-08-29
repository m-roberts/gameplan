# GamePlan brand specification

GamePlan uses an ink-dark navy foundation, luminous electric blue as its main signal, violet for depth, and a tightly controlled warm orange highlight drawn directly from the project artwork.

## Core tokens

```css
:root {
  --bg: oklch(18.11% 0.0185 279.44);
  --surface: oklch(22.27% 0.0275 277.64);
  --fg: oklch(96.84% 0.016 289.93);
  --muted: oklch(80.12% 0.0271 276.31);
  --border: oklch(40.12% 0.046 276.02);
  --accent: oklch(72.17% 0.1449 274.81);
}
```

Supporting artwork colours: warm orange `oklch(77.96% 0.1671 64.61)`, electric violet `oklch(55.22% 0.2589 284.5)`, and cyan `oklch(82.21% 0.127 221.51)`.

## Type

- Display: `"Trebuchet MS", "Avenir Next", ui-sans-serif, sans-serif`
- Body: `"Avenir Next", "Segoe UI", ui-sans-serif, system-ui, sans-serif`
- Mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`

## Posture

- The robot artwork is the primary brand asset and is reproduced without modification.
- Dark navy surfaces create depth through borders and tonal contrast, not heavy shadows.
- Electric colour behaves like interface light: focused around controls, status, and small diagram details.
- Orange is a high-signal human accent for live or time-sensitive moments, never a page-wide wash.
- Product terms and planning states provide the visual story; generic gaming decoration stays secondary.

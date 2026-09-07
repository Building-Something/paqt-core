# PAQT — UX / DESIGN SYSTEM

## Brand
Name: **Paqt**
Pronunciation: "pakt".

Personality:
- calm,
- precise,
- trustworthy,
- modern,
- analytical.

Avoid:
- generic AI gradients,
- excessive glassmorphism,
- fake legal authority,
- dashboard clutter.

## Visual direction
Use a restrained blue/indigo primary accent, neutral backgrounds, high-contrast text, and severity colors only where semantic.

Use lucide-react for icons.

## Shell
Desktop:
- sticky top navigation,
- Paqt wordmark,
- New Analysis action,
- subtle status indicator.

Landing:
- strong hero,
- large upload surface,
- three-step explanation,
- security/privacy note,
- disclaimer.

## Analysis workspace
Desktop grid:
- 360–420px summary rail,
- flexible document canvas,
- 360–420px assistant rail.

Do not force fixed widths on mobile.

## Loading experience
Never show a fake percentage that implies exact completion.
Use truthful phase text:
- Extracting contract text…
- Preparing pages…
- Analyzing pages 1–8 of 42…
- Consolidating findings…
- Preparing decision brief…

## Risk UI
Risk cards should show:
- severity,
- category,
- page,
- short description,
- quoted clause,
- recommendation.

Clicking a risk:
- selects it,
- scrolls/jumps to its page,
- highlights the risk marker,
- opens the relevant chat discussion.

## Empty/error states
Every async feature needs:
- loading,
- empty,
- error,
- retry.

Errors must be understandable and actionable.

## Accessibility
- keyboard-focusable buttons,
- visible focus states,
- semantic headings,
- labels for inputs,
- title/aria-label on icon buttons,
- do not rely on color alone for severity,
- modal focus behavior,
- Escape closes modal where appropriate.

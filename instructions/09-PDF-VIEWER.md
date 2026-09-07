# PAQT — PDF VIEWER

## Requirements
Use react-pdf and configure its worker correctly.

Single-page viewing is acceptable and preferred for predictable annotation.

Controls:
- previous/next,
- page indicator,
- zoom out/in,
- reset 100%,
- fullscreen,
- download original PDF.

Zoom:
- minimum 0.5,
- maximum 3,
- step 0.2,
- default 1.2.

## Risk markers
For risks on the current page:
- render numbered markers,
- use semantic severity styling,
- include a ping/attention treatment for selected risks,
- keep markers inside the document viewport.

Hover:
- category,
- description,
- severity,
- "Click for details",
- quoted risky text.

Click:
- select risk,
- call the analysis-page risk handler,
- synchronize with the chat.

## Page navigation
When a risk is selected:
1. set current page,
2. wait for page render if needed,
3. locate the searchable text where practical,
4. show the risk marker/selected state.

Do not claim pixel-perfect clause highlighting if only text extraction is available. A marker is safer than fabricated coordinates.

## Failure mode
If the PDF renders but extraction has no text:
show:
"This PDF may be scanned or image-based. Paqt could not reliably extract text from one or more pages."
Do not hallucinate risks for missing text.

# PAQT — COMPONENTS + ROUTES

## Routes
`/` — landing/upload
`/analysis` — active analysis workspace
`/analysis/:id` — analysis session route if a stable session id is used
`/privacy` — privacy explanation
`/about` — product explanation

The MVP can keep analysis state in context while retaining route structure for future persistence.

## Components
```text
src/components/
  AppShell.tsx
  Header.tsx
  UploadDropzone.tsx
  AnalysisProgress.tsx
  ContractSummary.tsx
  RiskBreakdown.tsx
  RiskList.tsx
  RiskCard.tsx
  PdfViewer.tsx
  RiskMarker.tsx
  ChatInterface.tsx
  ChatMessage.tsx
  EmptyState.tsx
  ErrorState.tsx
  ExportButton.tsx
  Disclaimer.tsx
```

## Pages
```text
src/pages/
  HomePage.tsx
  AnalysisPage.tsx
  PrivacyPage.tsx
  AboutPage.tsx
```

## Services
```text
src/services/
  groqService.ts
  pdfService.ts
  exportService.ts
```

## Context
`AnalysisContext.tsx`
Own:
- file,
- contract text,
- page data,
- analysis,
- selected risk,
- chat messages,
- progress,
- error.

Keep service code outside React components.

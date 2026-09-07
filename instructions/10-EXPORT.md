# PAQT — EXPORT

## XLSX
Use `xlsx` + `file-saver`.

Sheet name:
`Risks`

Columns:
- Risk
- Severity
- Quoted Text
- Page
- Reason
- Recommendation

Filename:
`paqt_<sanitized-original-filename>_risks.xlsx`

## Data rules
- Export only analyzed risks.
- Preserve exact quoted text.
- Preserve page numbers.
- Title-case severity.
- Do not add AI-generated fields that are not present in the analysis model.

## PDF
The MVP should provide original PDF download.

A polished analyzed-report PDF can be a later feature. Do not implement a fragile browser screenshot pipeline merely to claim a report export.

# PAQT — PRODUCT STRATEGY

## Positioning
**Paqt is an AI contract decision layer.**

Tagline:
**Know what you're signing.**

Supporting line:
**Paqt finds the clauses that deserve your attention, shows you exactly where they live, and turns them into practical next steps.**

## Why Paqt should exist
Generic contract summarizers produce prose. Users need decisions:
- Is there an unusually broad termination right?
- When and how do I get paid?
- Who owns the work?
- What happens if the other side delays?
- Is liability uncapped?
- What am I actually agreeing to?

Paqt makes the answers inspectable.

## Primary user journey
1. Upload PDF.
2. See extraction progress.
3. See analysis progress with real page ranges.
4. Land on a decision dashboard.
5. Click a risk.
6. PDF jumps to the relevant page.
7. Read the quoted clause.
8. Ask Paqt a follow-up question.
9. Export the findings for discussion.

## Information architecture
### Home
- value proposition,
- upload,
- examples,
- trust/security explanation,
- legal disclaimer.

### Analysis workspace
Three-zone desktop layout:
- left: decision summary and risks,
- center: source document,
- right: AI conversation.

On mobile:
- summary,
- document,
- assistant as stacked sections with a sticky action bar.

## Risk model
Four levels:
- Critical: material exposure or severe unfavorable provision.
- High: meaningful commercial/legal disadvantage worth negotiating.
- Medium: ambiguity or moderate disadvantage.
- Low: clarification or minor concern.

Overall score is a decision-support signal, not a legal probability.

## "Decision card" concept
Each risk should answer:
- What is it?
- Where is it?
- Why should I care?
- What can I do?

This is the heart of Paqt.

## Demo strategy
Seed a small set of sample contracts only if useful to demonstrate the UI, but do not imply they are real customer documents.

Best demo moment:
Upload a 15–50 page contract and visibly show:
- page-aware progress,
- risks appearing with page numbers,
- clicking a risk moving the document,
- asking "What should I negotiate?",
- exporting a clean spreadsheet.

## Future roadmap
### V1
PDF risk analysis + evidence + chat + export.

### V1.5
Saved analysis sessions using a small database.

### V2
Clause comparison between two contracts.

### V2
Negotiation brief: generate a prioritized list of asks.

### V2
Contract redline suggestions, always requiring user approval.

### V3
Team workspace, permissions, retention policies, audit trail.

### V3
Integrations with Google Drive, Dropbox, email and procurement systems.

## Monetization hypothesis
Free:
- limited analyses/month,
- limited document size.

Pro:
- higher limits,
- saved analyses,
- exports,
- clause comparison.

Team:
- shared workspaces,
- audit history,
- policy templates,
- organization controls.

Do not implement billing in the MVP. Design the UI so a pricing page can be added without changing the core architecture.

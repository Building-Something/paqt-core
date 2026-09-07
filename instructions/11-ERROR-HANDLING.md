# PAQT — ERROR HANDLING

## Principles
Never swallow the real error.
Never show a blank screen.
Never leave the user trapped in an infinite spinner.

## Error mapping
### Missing key
"Groq API key is not configured on the server. Add GROQ_API_KEY and restart Paqt."

### Invalid key
"Your Groq API key was rejected. Check the server environment variable."

### Rate limit
"The AI service is temporarily rate-limited. Paqt will retry automatically; try again shortly."

### Timeout
"The AI analysis took too long. Try a shorter contract or try again."

### PDF extraction
"PaQt could not reliably extract text from this PDF."

### Invalid AI JSON
"AI returned an unexpected analysis format. Please retry."

### Unknown
"Something went wrong while analyzing this contract. Please try again."

Always preserve the technical cause in server logs, but do not expose secrets.

## Retry UX
For recoverable errors:
- show Retry,
- retain the uploaded file,
- retain extracted text where possible,
- avoid forcing a new upload.

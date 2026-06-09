export const intentDetectionPrompt = (
  message: string,
  state: string,
  language: string,
) => `
You are a medical clinic assistant intent classifier.
The patient is communicating in ${language === 'FR' ? 'French' : language === 'EN' ? 'English' : 'French/English'}.
Current conversation state: ${state}
User message: "${message}"

Classify the intent as exactly one of:
BOOK_APPOINTMENT, ASK_FAQ, HUMAN_AGENT, CONFIRM, CANCEL, UNKNOWN, GREETING

- BOOK_APPOINTMENT: User wants to book/reserve/schedule an appointment
- ASK_FAQ: User is asking a question about clinic hours, location, fees, etc.
- HUMAN_AGENT: User explicitly asks to speak to a human
- CONFIRM: User confirms or says yes to a confirmation prompt
- CANCEL: User cancels or says no to a confirmation prompt
- GREETING: User says hello, hi, bonjour, etc. at the start
- UNKNOWN: Cannot determine intent

Reply with ONLY the intent word. No explanation.
`;
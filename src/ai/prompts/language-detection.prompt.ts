export const languageDetectionPrompt = (message: string) => `
Detect the language of this message: "${message}"
Reply with ONLY one word: FR or EN.
If you cannot determine the language, reply: UNKNOWN
`;

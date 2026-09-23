export function normalizePatientPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return /^0\d{9}$/.test(digits) ? `212${digits.slice(1)}` : digits;
}

const STOP_WORDS = new Set([
  'stop', 'unsubscribe', 'stop messages', 'stop messaging me',
  'arretez', 'arrêtez', 'arret', 'arrêt', 'ne me contactez plus',
  'لا تراسلني', 'لا تراسلوني', 'توقف', 'توقفوا', 'إيقاف',
]);

export function isExplicitOptOut(text: string): boolean {
  return STOP_WORDS.has(text.normalize('NFKC').trim().toLocaleLowerCase());
}

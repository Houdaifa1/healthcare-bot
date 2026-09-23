import { isExplicitOptOut, normalizePatientPhone } from './phone.util';

describe('contact preference inputs', () => {
  it('normalizes local and international Moroccan phone forms to one key', () => {
    expect(normalizePatientPhone('06 00 00 00 01')).toBe('212600000001');
    expect(normalizePatientPhone('+212600000001')).toBe('212600000001');
  });

  it('recognizes explicit stop requests without treating ordinary care messages as opt-out', () => {
    for (const message of ['STOP', 'Arrêtez', 'لا تراسلني', 'unsubscribe']) {
      expect(isExplicitOptOut(message)).toBe(true);
    }
    expect(isExplicitOptOut('I stopped taking medicine')).toBe(false);
  });
});

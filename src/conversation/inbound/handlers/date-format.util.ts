import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

// Shared date-formatting helpers — previously duplicated verbatim across
// confirm/time handlers (message text) and doctor/date handlers (button
// labels).

/** "lundi 15 décembre 2025" / "Monday December 15 2025" — used in message text. */
export function formatFriendlyDate(isoDate: string, language: string): string {
  try {
    const d = parseISO(isoDate);
    return format(d, 'eeee dd MMMM yyyy', {
      locale: language === 'FR' ? fr : undefined,
    });
  } catch {
    return isoDate;
  }
}

/** "Lundi 15 décembre" — capitalized, no year, used for date-picker button titles. */
export function formatDateButtonLabel(isoDate: string, language: string): string {
  let label: string;
  try {
    const d = new Date(isoDate);
    label = format(d, 'eeee dd MMMM', {
      locale: language === 'FR' ? fr : undefined,
    });
  } catch {
    return isoDate;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Shared "did the patient tap a list row, type a number, or type the label"
// resolver — the same three-way lookup pattern specialty/doctor selection
// both needed, previously duplicated with only the prefix/field names
// differing between them.
export function resolveByIdOrIndex<T>(
  text: string,
  items: T[],
  opts: { prefix: string; idField: keyof T; labelField: keyof T },
): T | null {
  const trimmed = text.trim();

  if (trimmed.startsWith(opts.prefix)) {
    const idNum = parseInt(trimmed.slice(opts.prefix.length), 10);
    return items.find((item) => item[opts.idField] === (idNum as unknown)) ?? null;
  }

  const index = parseInt(trimmed, 10);
  if (!isNaN(index) && index >= 1 && index <= items.length) {
    return items[index - 1];
  }

  const normalised = trimmed.toLowerCase();
  return items.find((item) => String(item[opts.labelField]).toLowerCase() === normalised) ?? null;
}

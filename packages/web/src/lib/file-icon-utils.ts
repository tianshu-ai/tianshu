/** Ensure file icon label is readable: dark bg for missing labels, dark text for bright labels (js/py yellow). */
export function fileIconLabelFix(styles: Record<string, unknown>): Record<string, unknown> {
  if (!styles.labelColor) return { labelColor: '#555', labelTextColor: '#fff', labelUppercase: true };
  const lc = String(styles.labelColor);
  if (/^#[A-Fa-f0-9]{6}$/.test(lc)) {
    const r = parseInt(lc.slice(1, 3), 16), g = parseInt(lc.slice(3, 5), 16), b = parseInt(lc.slice(5, 7), 16);
    if (0.299 * r + 0.587 * g + 0.114 * b > 180) return { labelTextColor: '#333' };
  }
  return {};
}

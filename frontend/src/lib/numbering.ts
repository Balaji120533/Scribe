import type { ContentItem } from '@/types/paper-form';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * IEEE numbering for every sub-section in one section, keyed by item id:
 * level-2 sub-sections run A, B, C…; level-3 run 1, 2, 3… and restart under
 * each new level-2.
 *
 * The one source of truth for the editor's labels, the live preview and the
 * compiled document, so the letter a user sees on a sub-section while
 * editing is always the letter it gets in the paper. Numbering is by
 * position, the same as sections (II is always the second section), so a
 * newly added sub-section shows its own letter straight away instead of
 * every untitled one reading "A".
 */
export function subsectionNumbers(content: ContentItem[]): Map<string, string> {
  const numbers = new Map<string, string>();
  let level2 = 0;
  let level3 = 0;
  for (const item of content) {
    if (item.kind !== 'subsection') continue;
    if (item.level === 2) {
      level2++;
      level3 = 0;
      numbers.set(item.id, LETTERS[level2 - 1] ?? String(level2));
    } else {
      level3++;
      numbers.set(item.id, String(level3));
    }
  }
  return numbers;
}

/** The label as printed: "B." for a sub-section, "2)" for a sub-sub-section. */
export function subsectionLabel(level: 2 | 3, number: string): string {
  return level === 2 ? `${number}.` : `${number})`;
}

/**
 * Kebab-case slugs: lowercase ASCII letters and digits joined by single hyphens. Accents fold away
 * (`é` → `e`); every other character, other scripts included, becomes a separator. Shared by the
 * memory store's file names and the live-session registry's names.
 */

/** A kebab-case slug cut to `max` characters at a `-` (a lone longer word is cut hard). */
export function capSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const whole = slug[max] === '-' ? cut : cut.slice(0, Math.max(cut.lastIndexOf('-'), 0) || max);
  return whole.replace(/-+$/, '');
}

/** `text` as a kebab-case slug of at most `max` characters; empty when nothing survives. */
export function kebabSlug(text: string, max: number): string {
  return capSlug(
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    max,
  );
}

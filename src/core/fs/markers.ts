export interface CommentStyle {
  open: string;
  close?: string;
}

export const HASH_COMMENT: CommentStyle = { open: "#" };
export const HTML_COMMENT: CommentStyle = { open: "<!--", close: "-->" };

const NAME = "reins";

function markers(style: CommentStyle): { start: string; end: string } {
  const close = style.close ? ` ${style.close}` : "";
  return {
    start: `${style.open} >>> ${NAME} >>>${close}`,
    end: `${style.open} <<< ${NAME} <<<${close}`,
  };
}

/** True if the text already contains a Reins-managed block in this comment style. */
export function hasManagedBlock(text: string, style: CommentStyle = HASH_COMMENT): boolean {
  const { start, end } = markers(style);
  return text.includes(start) && text.includes(end);
}

/** Wrap a body in start/end markers (no surrounding blank lines). */
export function wrapManagedBlock(body: string, style: CommentStyle = HASH_COMMENT): string {
  const { start, end } = markers(style);
  return `${start}\n${body}\n${end}`;
}

/**
 * Insert or replace the Reins-managed block in `text`, leaving the rest of the
 * file untouched. Appends the block (after a blank line) when absent.
 */
export function upsertManagedBlock(
  text: string,
  body: string,
  style: CommentStyle = HASH_COMMENT,
): string {
  const { start, end } = markers(style);
  const block = wrapManagedBlock(body, style);
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s !== -1 && e !== -1 && e > s) {
    return `${text.slice(0, s)}${block}${text.slice(e + end.length)}`;
  }
  let base = text;
  if (base.length > 0 && !base.endsWith("\n")) base += "\n";
  if (base.length > 0) base += "\n";
  return `${base}${block}\n`;
}

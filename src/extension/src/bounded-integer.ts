/**
 * Integers a caller supplies, and what had to be done to them.
 *
 * The MCP SDK validates types and required fields and nothing else: a "maximum" in a tool's
 * schema is not enforced, so a caller asking for more than a tool allows is answered with
 * whatever that tool decides to do about it. Every tool here decides the same thing - bring the
 * value into range and carry on - and used to do it without saying so, which leaves a caller
 * whose run timed out after two minutes with no way to see that it asked for five.
 *
 * There were three copies of that decision with three different behaviours: one clamped both
 * ends and treated a non-integer as absent, one clamped the top and threw on the bottom, and one
 * threw on anything out of range at all. This is the one they share now, and it reports what it
 * did so a caller can see the value it actually got.
 */

/** The value to use, and a sentence saying what was done to the one that was asked for. */
export interface BoundedInteger {
  value: number;
  /** null when the caller's value stood as given. */
  note: string | null;
}

/**
 * A value as it may appear inside one line of an answer.
 *
 * The note a tool writes has to stay one line: it is read next to other fields, and a value
 * carrying a newline would push the rest of the answer out of alignment. JSON.stringify was
 * the obvious way to show a value and is the wrong one here - it throws on a BigInt and on a
 * circular structure, so a caller sending either turned a note about a bad number into an
 * error about reporting one - and an object or a long string would make the note enormous.
 */
export function describeValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    return "a value that cannot be shown";
  }
  const flat = text.replace(/\s+/g, " ").trim();
  const shown = flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
  try {
    return JSON.stringify(shown);
  } catch {
    return "a value that cannot be shown";
  }
}

/**
 * One integer, brought into `min..max`.
 *
 * A value that is not an integer at all - "300000" as a string, or 300000.5 - is answered with
 * the fallback rather than rejected, which is the one part of the old behaviour worth keeping:
 * it is what lets a slightly wrong call still do something useful. It is also the part that was
 * most quietly wrong, because two minutes is a long way from five and nothing said so.
 */
export function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): BoundedInteger {
  if (value === undefined || value === null) return { value: fallback, note: null };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      value: fallback,
      note: `${name} was ${describeValue(value)}: not an integer in ${min}..${max}, so ${fallback} was used`,
    };
  }
  if (value < min) return { value: min, note: `${name} was ${value}: below ${min}, so ${min} was used` };
  if (value > max) return { value: max, note: `${name} was ${value}: above ${max}, so ${max} was used` };
  return { value, note: null };
}

/** Several bounds as one line for a tool's answer, or null when nothing was adjusted. */
export function boundedNotes(bounds: readonly BoundedInteger[]): string | null {
  const notes = bounds.map((bound) => bound.note).filter((note): note is string => Boolean(note));
  if (notes.length === 0) return null;
  return `adjusted: ${notes.join("; ")}.`;
}


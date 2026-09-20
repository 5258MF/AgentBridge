/**
 * The default filters the file-discovery tools run under, and how a result explains them.
 *
 * A caller that cannot see a hidden file, or one behind an ignore rule, has no way to tell that
 * apart from the file being absent - and the usual next move, writing it from scratch, is exactly
 * the wrong one. So every result names the filters that were in force and the option that lifts
 * each. Not only the empty ones: a search that returns matches is equally not evidence that
 * nothing was filtered out, and that is the answer a caller is most likely to trust.
 *
 * How many paths a filter removed is deliberately not reported - ripgrep does not say what it
 * declined to walk - but whether a filter was applied at all is enough to know a second call is
 * worth making.
 */
export interface AppliedFileFilters {
  readonly ignored_skipped: boolean;
  readonly hidden_skipped: boolean;
}

/**
 * @param filters which default filters the call ran under
 * @param target what the caller was looking for, named in the note ("file", "text")
 * @param found whether the result held anything; that changes what the note has to warn about
 */
export function describeSkippedFilters(filters: AppliedFileFilters, target: string, found: boolean): string | undefined {
  const skipped = [
    ...(filters.ignored_skipped ? ["ignored files and common generated directories"] : []),
    ...(filters.hidden_skipped ? ["hidden paths"] : []),
  ];
  if (skipped.length === 0) return undefined;
  const lifts = [
    ...(filters.ignored_skipped ? ["no_ignore=true"] : []),
    ...(filters.hidden_skipped ? ["include_hidden=true"] : []),
  ].join(" and/or ");
  if (!found) {
    return `NOTE: nothing matched. Skipped by default: ${skipped.join("; ")}. That is not proof the ${target} is absent — retry with ${lifts} if it may be among them.`;
  }
  return `NOTE: skipped by default: ${skipped.join("; ")}. Anything inside them is missing from this result — pass ${lifts} to include them.`;
}

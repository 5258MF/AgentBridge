/**
 * Two small things the file tools share.
 *
 * They were written once per module - `estimateTokens` in `read_files` and in `search_files`,
 * `mapWithConcurrency` in `find_files` and in `read_files` - which is four copies of two
 * answers that have to agree: a token estimate that disagrees between two tools is a budget
 * one of them cannot keep, and a pool that disagrees is a concurrency bug that only shows up
 * on the slower of the two.
 */

/**
 * How many tokens a piece of text is worth, for the budgets the file tools report against.
 *
 * Four characters to a token is the rule of thumb every client-side estimate uses, and it is
 * deliberately not a tokenizer: the number is a hint to a caller deciding what to ask for
 * next, and a caller comparing it with its own count has to be able to arrive at the same
 * one. Ceiling, because a partial token is still billed as a whole one.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Run `worker` over every value, at most `concurrency` of them at a time, keeping the order.
 *
 * A plain Promise.all over thousands of paths opens thousands of file descriptors at once,
 * which is how a walk over a large tree runs out of them; the pool is what keeps a `stat` per
 * file affordable. Results come back in the order they were given, so a caller can count on
 * the answer being in the same order as the walk.
 */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

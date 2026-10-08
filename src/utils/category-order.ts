/**
 * Final walk order (keys and refs) after adding new categories. Each new category goes
 * after the key or ref it names; consecutive after=null ones go first in the order
 * given (so a first scan keeps the AI's walk order); an unknown `after` goes last.
 */
export function orderWithNewCategories(
  existing: string[],
  added: { ref: string; after: string | null }[]
): string[] {
  const order = [...existing];
  let lastLeading = -1;
  for (const { ref, after } of added) {
    if (after === null) {
      order.splice(++lastLeading, 0, ref);
      continue;
    }
    const at = order.indexOf(after);
    if (at === -1) order.push(ref);
    else {
      order.splice(at + 1, 0, ref);
      if (at <= lastLeading) lastLeading++;
    }
  }
  return order;
}

/**
 * #880: the min-height floors (any `min-h-*` class but `min-h-0`, whatever its variant prefix) on `from` and every ancestor up to `to`, inclusive.
 * jsdom lays nothing out, so a Full screen layer that must fit a short sideways viewport is checked by its classes: a floor anywhere on the chain holds the layer taller than the screen.
 */
export function minHeightFloors(from: Element, to: Element): string[] {
  const floors: string[] = [];
  for (let node: Element | null = from; node; node = node.parentElement) {
    for (const name of node.classList) if (/^(?:[^:]+:)*min-h-/.test(name) && !/(?:^|:)min-h-0$/.test(name)) floors.push(name);
    if (node === to) break;
  }
  return floors;
}

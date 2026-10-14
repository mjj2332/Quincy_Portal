import { Badge } from "../reui/badge";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "../reui/item";

/** One consequence of a removal: a title, what happens, and (for a release) a chip. */
export type ImpactRow = { key: string; title: string; description: string; badge?: string };
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a removal hides, one row each (the Remove version and Delete confirmations share it); an empty list says nothing else is affected. */
export function RemovalImpactList({ rows, testId }: { rows: ImpactRow[]; testId: string }) {
  return <ItemGroup data-testid={testId}>
    {rows.length === 0
      ? <Item size="xs" className="px-0"><ItemContent><ItemTitle className="font-normal">Nothing else is affected.</ItemTitle></ItemContent></Item>
      : rows.map((row) => <Item key={row.key} size="xs" className="px-0"><ItemContent>
        <ItemTitle className="font-normal">{row.title}{row.badge && <Badge variant="warning-light" size="sm">{row.badge}</Badge>}</ItemTitle>
        <ItemDescription className="line-clamp-none">{row.description}</ItemDescription>
      </ItemContent></Item>)}
  </ItemGroup>;
}

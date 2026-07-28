import { asc, desc, sql } from "drizzle-orm";
import * as schema from "./schema";

export const dashboardProjectOrder = [
  asc(sql`case when ${schema.projects.shootDate} is null then 1 else 0 end`),
  desc(schema.projects.shootDate),
] as const;

const dashboardStreetCollator = new Intl.Collator("en-AU", { sensitivity: "accent" });

export function orderDashboardStreetTies<T extends { project: { id: string; street: string; shootDate: string | null } }>(rows: T[]): T[] {
  const ordered: T[] = [];
  for (let start = 0; start < rows.length;) {
    const shootDate = rows[start]!.project.shootDate;
    let end = start + 1;
    while (end < rows.length && rows[end]!.project.shootDate === shootDate) end += 1;
    ordered.push(...rows.slice(start, end).sort((left, right) => {
      const byStreet = dashboardStreetCollator.compare(left.project.street, right.project.street);
      if (byStreet !== 0) return byStreet;
      return left.project.id < right.project.id ? -1 : left.project.id > right.project.id ? 1 : 0;
    }));
    start = end;
  }
  return ordered;
}

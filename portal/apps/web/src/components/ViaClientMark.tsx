import { Badge } from "@/components/reui/badge";

/**
 * #704 — the "via ‹client›" provenance marker next to the author of a comment or an activity row that an AI client
 * (MCP) wrote on the person's behalf. An outline `reui/badge` in secondary text, sentence case, like
 * `AutomaticDeadlineMark`, so it reads as provenance and adds no filled emphasis. The client name is registration
 * metadata the staff member consented to, rendered as text (never markup). Renders nothing for a browser action.
 */
export function ViaClientMark({ client }: { client: string | null | undefined }) {
  if (!client) return null;
  return <Badge
    variant="outline"
    radius="full"
    data-testid="via-client-mark"
    className="normal-case tracking-normal text-foreground-secondary"
  >{`via ${client}`}</Badge>;
}

/**
 * Things that must stop the moment the signed-in person's session is over (a 401, an access loss), whichever screen is mounted. A module
 * store that outlives a screen (film uploads, #741) registers here; the callers that end the principal's data announce it. Kept apart from
 * `project-data.ts` so a store may register without importing it.
 */
const handlers = new Set<() => void>();
export function onPrincipalTerminal(handler: () => void): () => void { handlers.add(handler); return () => { handlers.delete(handler); }; }
export function announcePrincipalTerminal(): void { for (const handler of [...handlers]) handler(); }

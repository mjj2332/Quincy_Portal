/**
 * Things that must stop the moment a signed-in person's session is over (a 401, an access loss), whichever screen is mounted. A module
 * store that outlives a screen (film uploads, #741) registers here; the callers that end the principal's data announce it. Kept apart from
 * `project-data.ts` so a store may register without importing it.
 *
 * The notice names the query client (one per signed-in session) that saw it. A retired session's late 401, even for the SAME account signed
 * back in, must not stop what the fresh session owns, so a handler acts only on uploads started under that client. An unnamed notice means everyone.
 */
const handlers = new Set<(queryClient: object | undefined) => void>();
export function onPrincipalTerminal(handler: (queryClient: object | undefined) => void): () => void { handlers.add(handler); return () => { handlers.delete(handler); }; }
export function announcePrincipalTerminal(queryClient?: object): void { for (const handler of [...handlers]) handler(queryClient); }

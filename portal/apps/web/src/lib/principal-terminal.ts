/**
 * Things that must stop the moment a signed-in person's session is over (a 401, an access loss), whichever screen is mounted. A module
 * store that outlives a screen (film uploads, #741) registers here; the callers that end the principal's data announce it. Kept apart from
 * `project-data.ts` so a store may register without importing it.
 *
 * The notice names the person whose session ended. A retired person's late 401 (a request still in flight after an impersonation switch)
 * must not stop what the current person owns, so a handler acts only on its own person's id. An unnamed notice means everyone.
 */
const handlers = new Set<(principalId: string | undefined) => void>();
export function onPrincipalTerminal(handler: (principalId: string | undefined) => void): () => void { handlers.add(handler); return () => { handlers.delete(handler); }; }
export function announcePrincipalTerminal(principalId?: string): void { for (const handler of [...handlers]) handler(principalId); }

/** Which person each query client belongs to: a client is made for one principal (`QuincyQueryProvider`) and never re-used for another. */
const clientPrincipals = new WeakMap<object, string>();
export function bindQueryClientPrincipal(queryClient: object, principalId: string): void { clientPrincipals.set(queryClient, principalId); }
export function principalOfQueryClient(queryClient: object): string | undefined { return clientPrincipals.get(queryClient); }

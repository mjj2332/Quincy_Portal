/**
 * Kicks are independent: a broken Durable Object must not strand every other
 * Dropbox connection. The aggregate failure keeps the RPC caller retryable.
 */
export async function fanOutDropboxKicks(
  connectionIds: readonly string[],
  kick: (connectionId: string) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(connectionIds.map(kick));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, `${failures.length} Dropbox webhook kick(s) failed`);
}

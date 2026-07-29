/** Lease duration for a `raw_reconciliation_claims` row — shared so every holder (Dropbox RAW
 * sync, admin asset deletion) renews to the same window rather than drifting independently. */
export const RAW_CLAIM_LEASE_MS = 15 * 60_000;

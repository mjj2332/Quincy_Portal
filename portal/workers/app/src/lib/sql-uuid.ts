/**
 * A random UUID version 4 as a SQL expression (#741 15b). `INSERT ... SELECT` over several rows needs one id per row, which only SQL can mint (a bound parameter is the same for every
 * row). `randomblob` is evaluated per row, the third group starts with `4` and the fourth with one of `8`, `9`, `a`, `b`, so each value matches the `UUID` shape the guest routes accept.
 * Tested in `test/sql-uuid.test.ts`.
 */
export const SQL_UUID_V4 = "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

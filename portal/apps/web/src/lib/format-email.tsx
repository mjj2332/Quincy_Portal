import { Fragment } from "react";

/**
 * An email address with `<wbr>` break opportunities after `@` and before each `.`. The text content
 * is unchanged (copy/paste and text queries see the plain address). Pair with
 * `[overflow-wrap:break-word]` on the cell: min-content then drops to the longest segment, so a
 * table column can shrink and breaks land at `@`/`.` instead of mid-word (#633).
 */
export function EmailText({ email }: { email: string }) {
  const segments = email.split(/(?=\.)|(?<=@)/);
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {segment}
        </Fragment>
      ))}
    </>
  );
}

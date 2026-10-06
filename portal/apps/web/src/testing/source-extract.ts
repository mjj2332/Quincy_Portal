/** Source-text extractors shared by the focus guard tests (not a test file, so importing it does not re-run a suite). */

/** Drops block comments and whole-line `//` comments, so a comment that names the class can't satisfy the guard (Sol). */
export const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The `<tag ...>` opening element that carries `marker`, from `<tag` to the first `>` outside braces. */
export function openingTag(source: string, tag: string, marker: string): string | null {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const start = source.lastIndexOf(`<${tag}`, at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") return stripComments(source.slice(start, i + 1));
  }
  return null;
}

/** The `POPOVER_CONTENT` initialiser, `const` through the terminating semicolon. */
export function constInitialiser(source: string, name: string): string | null {
  const init = new RegExp(`const ${name}\\s*=[\\s\\S]*?;`).exec(source)?.[0];
  return init === undefined ? null : stripComments(init);
}

/** The body of `function name(...) {...}`, brace-matched from the first `{` after the signature's closing `)`. Comments stripped. */
export function functionBody(source: string, name: string): string | null {
  const at = source.search(new RegExp(`function ${name}\\b\\s*\\(`));
  if (at < 0) return null;
  let paren = 0;
  let i = source.indexOf("(", at);
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")" && --paren === 0) break;
  }
  const open = source.indexOf("{", i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}" && --depth === 0) return stripComments(source.slice(open, j + 1));
  }
  return null;
}


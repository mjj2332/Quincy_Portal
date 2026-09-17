/**
 * Tracked-symlink guard — no symlink may be committed to this repository.
 *
 * Five `node_modules` symlinks were committed onto `main` in #180. They are how an agent gives a
 * throwaway worktree its dependencies without a second `npm install`, and `git add -A` staged them
 * because the only rule that covered them was `portal/.gitignore`'s `node_modules/` — a trailing
 * slash matches a directory, and to git a symlink is a file, so the rule never applied. The root
 * `.gitignore` had no rule at all.
 *
 * What that costs is not tidiness. Every one of them stored an absolute path into one machine's
 * checkout, and the root one pointed at itself, so a fresh clone got a self-referential
 * `node_modules`. It also wedged the author's own working tree: `git merge --ff-only` refused to
 * advance `main` with "Updating the following directories would lose untracked files in them",
 * and CI stayed green throughout, because the runner installs over the link before anything reads
 * it. Nothing failed at the point the mistake was made.
 *
 * The guard is deliberately broader than `node_modules`: it asks git for every tracked symlink
 * (mode 120000) and allows none. This repo has never needed a committed symlink, and the failure
 * mode is the same whatever the name — a path that is correct on exactly one machine.
 *
 * It lives beside `ci-vitest-configs.guard.test.ts` for the same reason that one does: a repo-wide
 * concern in the one package whose vitest config CI has always invoked.
 *
 * **If this fails, do not add an exception.** Run `git rm --cached <path>` and confirm the path is
 * covered by a `.gitignore` rule written without a trailing slash.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("tracked symlinks", () => {
  it("commits no symlink anywhere in the repository", () => {
    // `ls-files -s` prints the mode for each tracked path; 120000 is git's mode for a symlink.
    const tracked = execFileSync("git", ["ls-files", "-s"], { cwd: repoRoot, encoding: "utf8" });
    const symlinks = tracked
      .split("\n")
      .filter((line) => line.startsWith("120000 "))
      .map((line) => line.split("\t").slice(1).join("\t"));
    expect(symlinks).toEqual([]);
  });
});

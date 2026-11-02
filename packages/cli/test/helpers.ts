import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PRInput } from "@prstory/core";
import { loadLocalPR } from "../src/local";

type Files = Record<string, string | null>; // null deletes the file

/** Make a throwaway git repo with a base commit and a head commit, and load it as a PR. */
export function makePR(base: Files, head: Files, meta: { title?: string; body?: string } = {}): PRInput {
  const dir = mkdtempSync(join(tmpdir(), "prstory-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    write(dir, base);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    write(dir, head);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", meta.title ?? "head");
    return loadLocalPR(dir, "main", "feature", { title: meta.title ?? "Test PR", body: meta.body ?? "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir: string, files: Files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

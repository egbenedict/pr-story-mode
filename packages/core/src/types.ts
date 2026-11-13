// Core data types. Kept free of browser and Node APIs so the pipeline runs anywhere.

export type Side = "LEFT" | "RIGHT";

/** One changed line of a diff: LEFT lines are removed (base line numbers), RIGHT lines are added (head line numbers). */
export type DiffLineRef = { side: Side; line: number };

export type HunkLine =
  | { type: "context"; text: string; oldLine: number; newLine: number }
  | { type: "del"; text: string; oldLine: number }
  | { type: "add"; text: string; newLine: number };

export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string; // text after the second @@, often the enclosing function
  lines: HunkLine[];
};

export type FileStatus = "added" | "removed" | "modified" | "renamed";

export type FileDiff = {
  path: string; // head path (base path for removed files)
  oldPath: string; // base path (same as path unless renamed)
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
};

export type PRFile = FileDiff & {
  baseText?: string; // full base file, when available
  headText?: string; // full head file, when available
};

export type PRInput = {
  number: number;
  title: string;
  body: string;
  url?: string; // GitHub PR URL, used for links back to the Files view
  repo?: string; // "owner/name"
  baseSha: string; // merge base the diff is computed against
  headSha: string;
  files: PRFile[];
  /** Issues the description says the PR fixes or closes. */
  issues?: { number: number; title: string; body: string; url?: string }[];
};

export type MechanicalKind = "format" | "rename" | "imports" | "generated" | "lockfile";

export type ChangeAtom = {
  id: string; // stable hash of file + symbol path + head SHA
  file: string;
  language: string | null;
  symbolPath: string[]; // e.g. ["Scheduler", "replan"]
  kind: "added" | "removed" | "modified" | "moved" | "renamed";
  baseRange?: { start: number; end: number };
  headRange?: { start: number; end: number };
  hunkLines: DiffLineRef[]; // exact diff lines covered
  mechanical?: MechanicalKind;
  defines: string[]; // symbols defined or changed
  references: string[]; // symbols used
  supportTier: 0 | 1 | 2;
  /** The whole file was deleted: one atom for all of it, shown folded under a summary of the top-level names it held. */
  deletedFile?: { names: string[] };
};

/**
 * A citation points at lines of a change atom (shown line numbers), or at lines of an unchanged
 * context snippet (`file` set, head line numbers; `atomId` is then empty).
 */
export type Citation = {
  atomId: string;
  lines: [number, number];
  file?: string;
  /** The words in the explanation that refer to these lines; readers make them a link. */
  phrase?: string;
};

/**
 * Unchanged code shown alongside a step: a definition the step uses, an existing caller of
 * something the step changes, or the header of the class the step's code sits in.
 * Line numbers are in the head version of the file; `code` holds those lines.
 */
export type ContextSnippet = {
  file: string;
  start: number;
  end: number;
  reason: "definition" | "caller" | "container";
  symbol: string; // the symbol that links it to the step
  within?: string; // for callers: the function (or table, class…) the use sits in
  called?: boolean; // for callers: the symbol is called there, not just referenced
  /** The opening line of `within`, when the snippet starts below it (shown above a "⋯" gap). */
  head?: { line: number; text: string };
  focus?: number[]; // lines that mention `symbol`
  code: string;
};

/**
 * One beat of a step's walkthrough: a few sentences, then the code they cover. `through` is the last
 * line the beat covers (atom and shown line number); the next beat continues after it.
 * A beat without `through` is prose only.
 */
export type Beat = { text: string; cites: Citation[]; through?: { atomId: string; line: number } };

export type StoryStep = {
  atomIds: string[]; // usually one atom
  label: string; // short plain label for the outline
  orderOverride?: string; // reason for breaking dependency order
  context?: ContextSnippet[]; // unchanged code shown alongside
  explanation: Beat[];
};

export type Story = {
  prNumber: number;
  headSha: string;
  summary: string; // two or three sentences shown at the top
  steps: StoryStep[];
  mechanical: string[]; // atom IDs, listed at the end
  meta: {
    model: string;
    provider: string;
    repairRounds: number;
    tokens: number;
    /** Set only for More detail; a story without it was written at Standard. */
    detail?: "more";
    /** Set when the story was updated from one for an earlier commit: steps carried over, and that commit. */
    reused?: { steps: number; from: string };
  };
};

// ---- LLM provider interface (implemented in @prstory/providers) ----

export type JSONSchema = Record<string, unknown>;
export type Msg = { role: "user" | "assistant"; content: string };
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };

export type CompletionRequest = {
  system: string;
  /** Stable text placed before `messages` so providers with prompt caching can reuse it across calls. */
  sharedPrefix?: string;
  messages: Msg[];
  schema?: JSONSchema;
  maxTokens: number;
  /** Called with each piece of output text as it streams, by providers that stream. */
  onText?: (delta: string) => void;
  /** Cancels the call (the reader's Stop button). Providers that can't cancel ignore it. */
  signal?: AbortSignal;
};

export type Completion = {
  text: string;
  json?: unknown;
  usage: Usage;
  /** The model that answered, when the provider reports it (it can differ from the requested one after a fallback). */
  model?: string;
};

export interface LLMProvider {
  id: string;
  model: string;
  capabilities: { jsonSchema: boolean; maxContextTokens: number; promptCaching: boolean };
  complete(req: CompletionRequest): Promise<Completion>;
}

export type MatchStatus =
  | "high_confidence"
  | "needs_review"
  | "low_confidence"
  | "not_found";

export interface MatchThresholds {
  high: number;
  review: number;
}
export interface MatchInput {
  artist: string;
  title: string;
  label?: string;
}
export interface CandidateInput {
  id: string;
  artist: string;
  title: string;
  label?: string;
  edition?: string;
}
export interface MatchResult {
  score: number;
  status: MatchStatus;
  signals: Record<string, number>;
  explanation: string;
}
export interface DuplicateGroup {
  normalizedArtist: string;
  normalizedTitle: string;
  candidateIds: string[];
}

export function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*(?:remix|mix|edit|version|deluxe|expanded)[^)]*\)/gi, " ")
    .replace(
      /\b(?:remaster(?:ed)?|deluxe|expanded|anniversary|edition)\b/gi,
      " ",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function similarity(left: string, right: string): number {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aw = new Set(a.split(" "));
  const bw = new Set(b.split(" "));
  const common = [...aw].filter((word) => bw.has(word)).length;
  return common / Math.max(aw.size, bw.size);
}

export function scoreMatch(
  input: MatchInput,
  candidate: CandidateInput,
  aliases: Record<string, string[]> = {},
  thresholds: MatchThresholds = { high: 85, review: 60 },
): MatchResult {
  const normalizedArtist = normalizeMatchText(input.artist);
  const artistAliases = [input.artist, ...(aliases[normalizedArtist] ?? [])];
  const artistScore = Math.max(
    ...artistAliases.map((alias) => similarity(alias, candidate.artist)),
  );
  const titleScore = similarity(input.title, candidate.title);
  const labelScore =
    input.label && candidate.label
      ? similarity(input.label, candidate.label)
      : 0;
  const signals = {
    exact_title: titleScore === 1 ? 1 : 0,
    title: titleScore,
    artist: artistScore,
    label: labelScore,
  };
  const score =
    Math.round((titleScore * 55 + artistScore * 35 + labelScore * 10) * 100) /
    100;
  const status: MatchStatus =
    score >= thresholds.high
      ? "high_confidence"
      : score >= thresholds.review
        ? "needs_review"
        : "low_confidence";
  const parts = [
    `title ${Math.round(titleScore * 100)}%`,
    `artist ${Math.round(artistScore * 100)}%`,
  ];
  if (labelScore) parts.push(`label ${Math.round(labelScore * 100)}%`);
  if (
    artistAliases.length > 1 &&
    artistScore > similarity(input.artist, candidate.artist)
  )
    parts.push("artist alias matched");
  return {
    score,
    status,
    signals,
    explanation: `${status}: ${parts.join(", ")}`,
  };
}

export function classifyNoCandidates(): MatchResult {
  return {
    score: 0,
    status: "not_found",
    signals: {},
    explanation: "not_found: no TIDAL candidates returned",
  };
}

export function detectDuplicateEditions(
  candidates: CandidateInput[],
): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const candidate of candidates) {
    const normalizedArtist = normalizeMatchText(candidate.artist);
    const normalizedTitle = normalizeMatchText(candidate.title);
    const key = `${normalizedArtist}\u0000${normalizedTitle}`;
    const group = groups.get(key) ?? {
      normalizedArtist,
      normalizedTitle,
      candidateIds: [],
    };
    if (!group.candidateIds.includes(candidate.id))
      group.candidateIds.push(candidate.id);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.candidateIds.length > 1);
}

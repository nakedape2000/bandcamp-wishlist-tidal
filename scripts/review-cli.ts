import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { loadConfig } from "../src/config";
import {
  type PortableReviewDecisions,
  type ReviewAction,
  type ReviewFilters,
  type ReviewRecord,
  ReviewService,
} from "../src/review";

const args = process.argv.slice(2);
if (args[0] === "review") args.shift();
const json = args.includes("--json");
const databasePath =
  option("--database") ??
  process.env.BCTS_DATABASE ??
  loadConfig().storage.database;
if (databasePath !== ":memory:")
  mkdirSync(dirname(databasePath), { recursive: true });
const command = args.shift() ?? "list";
const database = new Database(databasePath);
if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
const reviews = new ReviewService(database);

try {
  if (command === "list") list();
  else if (command === "show") printDetail(requiredId());
  else if (command === "browse") await browse();
  else if (["approve", "reject", "defer", "unavailable"].includes(command)) {
    const id = requiredId();
    const action = (
      {
        approve: "approved",
        reject: "rejected",
        defer: "deferred",
        unavailable: "unavailable",
      } as Record<string, ReviewAction>
    )[command] as ReviewAction;
    const candidate = option("--candidate");
    await confirm(`Save ${action} decision for Bandcamp item ${id}?`);
    printDecision(reviews.decide(id, action, candidate));
  } else if (command === "choose") {
    const id = requiredId();
    const candidate = args.shift();
    if (!candidate) throw new Error("choose requires a TIDAL candidate id.");
    await confirm(
      `Approve TIDAL candidate ${candidate} for Bandcamp item ${id}?`,
    );
    printDecision(reviews.decide(id, "approved", candidate));
  } else if (command === "edit") {
    const id = requiredId();
    const metadata = metadataOptions();
    if (!Object.keys(metadata).length)
      throw new Error("edit requires --artist, --title, or --label.");
    await confirm(`Save metadata edits for Bandcamp item ${id}?`);
    const edited = reviews.editMetadata(id, metadata);
    if (json) console.log(JSON.stringify({ ...edited, providerWrites: 0 }));
    else
      console.log(
        `Metadata saved for item ${edited.bandcampItemId}. Provider writes: 0.`,
      );
  } else if (command === "export") {
    const path = args.shift() ?? "./output/review-decisions.v1.json";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(reviews.exportDecisions(), null, 2),
      "utf8",
    );
    chmodSync(path, 0o600);
    if (json) console.log(JSON.stringify({ path, exported: true }));
    else console.log(`Exported review decisions to ${path}`);
  } else if (command === "import") {
    const path = args.shift();
    if (!path) throw new Error("import requires a JSON path.");
    const document = JSON.parse(
      readFileSync(path, "utf8"),
    ) as PortableReviewDecisions;
    await confirm(
      `Import ${document.decisions?.length ?? 0} review decisions?`,
    );
    const imported = reviews.importDecisions(document);
    if (json) console.log(JSON.stringify({ imported, providerWrites: 0 }));
    else
      console.log(`Imported ${imported} review decisions. Provider writes: 0.`);
  } else if (command === "pending") {
    const plan = reviews.pendingPlan();
    if (json) console.log(JSON.stringify({ ...plan, providerWrites: 0 }));
    else {
      printTable(plan.additions);
      console.log(
        `Current TIDAL library: ${plan.currentLibraryCount}; proposed additions: ${plan.additionCount}; provider writes: 0.`,
      );
    }
  } else if (command === "help" || command === "--help") {
    printHelp();
  } else {
    throw new Error(`Unknown review command: ${command}`);
  }
} finally {
  database.close();
}

function list(): void {
  const records = reviews.list(filterOptions());
  if (json) console.log(JSON.stringify({ records, count: records.length }));
  else printTable(records);
}

function printDetail(id: number): void {
  const record = reviews.get(id);
  if (!record) throw new Error(`Review item ${id} not found.`);
  if (json) console.log(JSON.stringify(record));
  else renderDetail(record);
}

function renderDetail(record: ReviewRecord): void {
  const decision = record.decision
    ? `${record.decision.action}${record.decision.chosenTidalAlbumId ? ` -> ${record.decision.chosenTidalAlbumId}` : ""}`
    : "not reviewed";
  console.log(
    `\n[${record.bandcampItemId}] ${record.artist} - ${record.title}`,
  );
  console.log(`Bandcamp: ${record.url || "unavailable"}`);
  console.log(
    `Status: ${record.status} | Score: ${record.score ?? "-"} | Label: ${record.label || "-"}`,
  );
  console.log(`Decision: ${decision}`);
  console.log(`Evidence: ${record.explanation}`);
  if (!record.candidates.length) {
    console.log("\nNo TIDAL candidates.");
  } else {
    console.log("\nTIDAL candidates:");
    record.candidates.forEach((candidate, index) => {
      const artists = Array.isArray(candidate.tidal_artists)
        ? candidate.tidal_artists.join(", ")
        : String(candidate.tidal_artist ?? "Unknown artist");
      console.log(
        `  ${index + 1}. ${artists} - ${String(candidate.tidal_title ?? "Untitled")} [${String(candidate.score ?? "-")}]`,
      );
      console.log(
        `     ${String(candidate.tidal_album_type ?? "-")} | ${String(candidate.tidal_release_date ?? "-")} | ${String(candidate.tidal_track_count ?? "-")} tracks`,
      );
      console.log(
        `     ${String(candidate.explanation ?? "No explanation recorded.")}`,
      );
      console.log(
        `     ${String(candidate.tidal_url ?? `https://tidal.com/browse/album/${String(candidate.tidal_album_id ?? "")}`)}`,
      );
    });
  }
  console.log("\nProvider writes: 0.");
}

async function browse(): Promise<void> {
  if (json)
    throw new Error(
      "review browse is interactive and does not support --json.",
    );
  if (!process.stdin.isTTY)
    throw new Error("browse requires an interactive terminal.");
  let records = reviews
    .list(filterOptions())
    .filter(
      (record) =>
        !record.decision &&
        (record.status === "needs_review" ||
          record.status === "low_confidence"),
    );
  if (!records.length) {
    console.log("No unreviewed candidates match these filters.");
    return;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let index = 0;
  try {
    while (records.length) {
      console.clear();
      console.log(`Review ${index + 1}/${records.length}`);
      renderDetail(records[index] as ReviewRecord);
      console.log(
        "\n[n] next  [p] previous  [a] approve  [c N] choose  [r] reject  [d] defer  [u] unavailable  [e] edit  [q] quit",
      );
      const input = (await prompt.question("> ")).trim();
      const [key, value] = input.split(/\s+/, 2);
      if (!key) continue;
      if (key === "q") break;
      if (key === "n") index = (index + 1) % records.length;
      else if (key === "p")
        index = (index - 1 + records.length) % records.length;
      else if (["a", "c", "r", "d", "u", "e"].includes(key)) {
        const current = records[index] as ReviewRecord;
        const changed = await applyBrowseAction(prompt, current, key, value);
        if (changed) {
          records = records.filter(
            (record) => record.bandcampItemId !== current.bandcampItemId,
          );
          index = Math.min(index, Math.max(0, records.length - 1));
        }
      }
    }
  } finally {
    prompt.close();
  }
  if (!records.length)
    console.log("Review queue complete. Provider writes: 0.");
}

async function applyBrowseAction(
  prompt: Interface,
  record: ReviewRecord,
  key: string,
  value?: string,
): Promise<boolean> {
  if (key === "e") {
    const artist = await prompt.question(`Artist [${record.artist}]: `);
    const title = await prompt.question(`Title [${record.title}]: `);
    const label = await prompt.question(`Label [${record.label}]: `);
    const metadata = Object.fromEntries(
      Object.entries({ artist, title, label }).filter(([, item]) =>
        item.trim(),
      ),
    );
    if (!Object.keys(metadata).length) return false;
    if (!(await confirmWith(prompt, "Save metadata edits?"))) return false;
    reviews.editMetadata(record.bandcampItemId, metadata);
    return false;
  }
  let candidateId: string | undefined;
  if (key === "a")
    candidateId = String(record.bestMatch?.tidal_album_id ?? "") || undefined;
  if (key === "c") {
    const candidateIndex = Number(value) - 1;
    candidateId = String(
      record.candidates[candidateIndex]?.tidal_album_id ?? "",
    );
    if (!candidateId) return false;
  }
  if (key === "r")
    candidateId = String(record.bestMatch?.tidal_album_id ?? "") || undefined;
  const action: ReviewAction =
    key === "a" || key === "c"
      ? "approved"
      : key === "r"
        ? "rejected"
        : key === "d"
          ? "deferred"
          : "unavailable";
  if (!(await confirmWith(prompt, `Save ${action} decision?`))) return false;
  reviews.decide(record.bandcampItemId, action, candidateId);
  return true;
}

function printTable(records: ReviewRecord[]): void {
  console.table(
    records.map((record) => ({
      id: record.bandcampItemId,
      artist: record.artist,
      title: record.title,
      status: record.decision?.action ?? record.status,
      score: record.score ?? "",
      candidate:
        record.decision?.chosenTidalAlbumId ??
        record.bestMatch?.tidal_album_id ??
        "",
    })),
  );
  console.log(`${records.length} review item(s). Provider writes: 0.`);
}

function printDecision(decision: ReturnType<ReviewService["decide"]>): void {
  if (json) console.log(JSON.stringify({ ...decision, providerWrites: 0 }));
  else
    console.log(
      `${decision.action} decision saved for item ${decision.bandcampItemId}. Provider writes: 0.`,
    );
}

function filterOptions(): ReviewFilters {
  return {
    status: option("--status"),
    artist: option("--artist"),
    label: option("--label"),
    minScore: numberOption("--min-score"),
    maxScore: numberOption("--max-score"),
    since: option("--since"),
  };
}

function metadataOptions(): Record<string, string> {
  return Object.fromEntries(
    ["artist", "title", "label"].flatMap((key) => {
      const value = option(`--${key}`);
      return value == null ? [] : [[key, value]];
    }),
  );
}

function requiredId(): number {
  const value = Number(args.shift());
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("A positive Bandcamp item id is required.");
  return value;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function numberOption(name: string): number | undefined {
  const value = option(name);
  if (value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return number;
}

async function confirm(question: string): Promise<void> {
  if (args.includes("--yes")) return;
  if (!process.stdin.isTTY)
    throw new Error("Confirmation requires an interactive terminal or --yes.");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    if (!(await confirmWith(prompt, question))) throw new Error("Cancelled.");
  } finally {
    prompt.close();
  }
}

async function confirmWith(
  prompt: Interface,
  question: string,
): Promise<boolean> {
  const answer = await prompt.question(`${question} [y/N] `);
  return answer.trim().toLowerCase() === "y";
}

function printHelp(): void {
  console.log(`Review commands:
  sync review list [--status STATUS] [--artist TEXT] [--label TEXT]
  sync review show ID
  sync review browse
  sync review approve|reject|defer|unavailable ID [--candidate TIDAL_ID]
  sync review choose ID TIDAL_ID
  sync review edit ID [--artist TEXT] [--title TEXT] [--label TEXT]
  sync review pending
  sync review export [PATH]
  sync review import PATH

Use --database PATH to select a database and --yes for scripted mutations.
Review commands never write to TIDAL.`);
}

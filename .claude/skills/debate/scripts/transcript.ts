// Read the claude-peers broker database for the /debate judge.
//
//   bun.exe .claude/skills/debate/scripts/transcript.ts hwm          -> prints the last message id ever assigned
//   bun.exe .claude/skills/debate/scripts/transcript.ts since <id>   -> JSON: live peers + messages with id > <id>
//
// `hwm` reads sqlite_sequence, not MAX(id): the messages table is AUTOINCREMENT, so a row the
// broker's sweep deleted still consumed its id, and MAX(id) would report a gap above it as a lost
// message. Reads only. The database path comes from CLAUDE_PEERS_DB, else <home>/.claude-peers.db.
import { Database } from "bun:sqlite";

const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const dbPath = process.env.CLAUDE_PEERS_DB ?? `${home}/.claude-peers.db`;
const [mode, arg] = process.argv.slice(2);

function usage(): never {
  console.error("usage: transcript.ts hwm | since <id>");
  process.exit(2);
}

if (mode !== "hwm" && mode !== "since") usage();

const db = new Database(dbPath, { readonly: true });

if (mode === "hwm") {
  const row = db
    .query(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'messages'), (SELECT MAX(id) FROM messages), 0) AS hwm",
    )
    .get() as { hwm: number };
  console.log(String(row.hwm));
} else {
  const since = Number(arg);
  if (!Number.isInteger(since) || since < 0) usage();
  const peers = db
    .query("SELECT id, pid, summary, registered_at, last_seen FROM peers ORDER BY registered_at ASC")
    .all();
  const messages = db
    .query(
      "SELECT id, from_id, to_id, sent_at, delivered, text FROM messages WHERE id > ? ORDER BY id ASC",
    )
    .all(since);
  console.log(JSON.stringify({ dbPath, since, peers, messages }, null, 2));
}

// Debate watcher for the host's Monitor tool: one stdout line per join, per message, per debater
// exit; exits when every listed debater is done or the deadline passes.
//
//   bun.exe .claude/skills/debate/scripts/watch.ts <hwm> <peers-json> <minutes> <role>=<exit-file> [<role>=<exit-file> ...]
//
// Each exit file is the one that role's launch command appends "exit=<code>" to when it returns.
// <peers-json> receives the id -> summary map as peers join — the broker deletes a peer's row
// within 30 s of its process exiting, so this snapshot is how the judge maps sender ids to roles
// afterward. Reads the database only. Path from CLAUDE_PEERS_DB, else <home>/.claude-peers.db.
import { Database } from "bun:sqlite";

const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const dbPath = process.env.CLAUDE_PEERS_DB ?? `${home}/.claude-peers.db`;
const [hwmArg, peerLog, minutesArg, ...pairs] = process.argv.slice(2);
const exitFiles = new Map<string, string>();
for (const pair of pairs) {
  const eq = pair.indexOf("=");
  if (eq > 0) exitFiles.set(pair.slice(0, eq), pair.slice(eq + 1));
}
if (!hwmArg || !peerLog || !minutesArg || exitFiles.size === 0) {
  console.error("usage: watch.ts <hwm> <peers-json> <minutes> <role>=<exit-file> [...]");
  process.exit(2);
}
let lastId = Number(hwmArg);
const deadline = Date.now() + Number(minutesArg) * 60 * 1000;
const seenPeers = new Map<string, string>();
const exited = new Set<string>();

async function noteExit(role: string, file: string) {
  if (exited.has(role)) return;
  try {
    const line = (await Bun.file(file).text()).split("\n").find((l) => l.includes("exit="));
    if (line) {
      exited.add(role);
      console.log(`EXIT ${role}: ${line.trim()}`);
    }
  } catch {}
}

while (Date.now() < deadline) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const peers = db.query("SELECT id, pid, summary FROM peers").all() as {
      id: string;
      pid: number;
      summary: string;
    }[];
    for (const p of peers) {
      if (p.summary.startsWith("debate:") && seenPeers.get(p.id) !== p.summary) {
        seenPeers.set(p.id, p.summary);
        console.log(`PEER ${p.summary} id=${p.id} pid=${p.pid}`);
        await Bun.write(peerLog, JSON.stringify(Object.fromEntries(seenPeers), null, 1));
      }
    }
    const messages = db
      .query("SELECT id, from_id, to_id, text FROM messages WHERE id > ? ORDER BY id")
      .all(lastId) as { id: number; from_id: string; to_id: string; text: string }[];
    for (const m of messages) {
      lastId = m.id;
      const from = seenPeers.get(m.from_id) ?? m.from_id;
      const to = seenPeers.get(m.to_id) ?? m.to_id;
      const tags = (m.text.match(/(ROUND \d+|FINAL STANDING|STANDING|PROPOSAL|MODEL)[^\n]*/g) ?? []).join(" | ");
      const head = m.text.replace(/\s+/g, " ").slice(0, 140);
      console.log(`MSG #${m.id} ${from} -> ${to} len=${m.text.length} :: ${tags || head}`);
    }
    db.close();
  } catch (error) {
    console.log(`ERR ${String(error).slice(0, 120)}`);
  }
  for (const [role, file] of exitFiles) await noteExit(role, file);
  if (exited.size === exitFiles.size) {
    console.log("DONE every debater exited");
    process.exit(0);
  }
  await Bun.sleep(5000);
}
console.log("DEADLINE reached with a debater still running — kill it and judge the transcript");

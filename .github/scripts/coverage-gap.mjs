// Portable coverage-gap renderer for any garnet-labs OSS fork.
// Reads the Jibril profile exported by the Garnet CI job, contrasts it with
// the reviewable diff (--numstat + full patch), and prints one Markdown
// comment to stdout.
//
// Env (all optional except DIFF_NUMSTAT):
//   PROFILE_PATH   — Jibril profile JSON path
//   LOCKFILE_PATH  — npm/pnpm lockfile (JSON). Ignored if absent — okay for Python/Go repos
//   DIFF_NUMSTAT   — output of `git diff --numstat <base>...<head>`
//   DIFF_PATCH_PATH — file with full `git diff <base>...<head>` patch
//   HEAD_SHA       — PR head SHA
//   REPO_LABEL     — human label to put in the marker suffix (e.g. "browser-use")
//   COVGAP_MARKER  — override marker (default "garnet-covgap")
import { readFile } from "node:fs/promises"

async function readJsonMaybe(path) {
  if (!path) return null
  try { return JSON.parse(await readFile(path, "utf8")) } catch { return null }
}
async function readTextMaybe(path) {
  if (!path) return ""
  try { return await readFile(path, "utf8") } catch { return "" }
}

const profile = await readJsonMaybe(process.env.PROFILE_PATH)
const lockfile = await readJsonMaybe(process.env.LOCKFILE_PATH)
const numstat = (process.env.DIFF_NUMSTAT || "").trim()
const patch = await readTextMaybe(process.env.DIFF_PATCH_PATH)
const repoLabel = process.env.REPO_LABEL || ""
const marker = process.env.COVGAP_MARKER || "garnet-covgap"

// --- static review surface ---
let added = 0, deleted = 0
const files = []
for (const line of numstat ? numstat.split("\n") : []) {
  const [a, d, file] = line.split("\t")
  if (!file) continue
  added += Number(a) || 0
  deleted += Number(d) || 0
  files.push(file)
}
const diffLines = added + deleted

// --- installed packages (npm lockfile if present) ---
const lockPackages = lockfile?.packages
  ? Object.keys(lockfile.packages).filter((k) => k !== "").length
  : null
const directDeps = lockfile?.packages?.[""]?.dependencies
  ? Object.keys(lockfile.packages[""].dependencies).length
  : null

// --- execution surface (Jibril profile) ---
let domains = [], connections = null
let processes = new Set(), lineageNodes = new Set(), detections = new Set()
if (profile) {
  domains = profile.network?.egress?.domains ?? []
  const peers = profile.network?.egress?.peers ?? []
  connections = peers.length
  for (const peer of peers) {
    for (const det of peer.detections ?? []) if (det !== "flow") detections.add(det)
    for (const tree of peer.proc_trees ?? []) {
      if (tree.process) processes.add(`${tree.process}:${tree.executable ?? ""}`)
      for (const node of tree.ancestry ?? []) lineageNodes.add(node)
    }
  }
}

const domainsInDiff = domains.filter((d) => patch.includes(d))
const n = (v) => (v === null || v === undefined ? "—" : String(v))

const out = []
out.push(`<!-- ${marker} -->`)
out.push("### Static review surface vs execution surface")
out.push("")
out.push("What the diff shows a reviewer, next to what the run actually did under the Garnet sensor. Facts from this PR head's execution record; judgment stays with the reviewer.")
out.push("")
out.push("| | Static review (the diff) | Execution (the recorded run) |")
out.push("| --- | --- | --- |")
out.push(`| Lines | ${diffLines} changed (${added}+ / ${deleted}−) | — |`)
if (lockPackages !== null) {
  out.push(`| Files / packages | ${files.length} file(s) touched | ${n(lockPackages)} package(s) installed (${n(directDeps)} direct) |`)
} else {
  out.push(`| Files touched | ${files.length} file(s) | — |`)
}
out.push(`| Processes | 0 visible in diff | ${profile ? processes.size : "—"} recorded process(es), ${profile ? lineageNodes.size : "—"} distinct lineage node(s) |`)
out.push(`| Outbound destinations | ${domainsInDiff.length} named in diff | ${profile ? domains.length : "—"} domain(s), ${n(connections)} connection(s) |`)
if (detections.size > 0) {
  out.push(`| Detections | — | ${[...detections].sort().join(", ")} |`)
}
out.push("")
if (domains.length > 0) {
  const unexplained = domains.filter((d) => !domainsInDiff.includes(d))
  out.push(`Recorded outbound domains: ${domains.map((d) => `\`${d}\``).join(", ")}.`)
  out.push(`${unexplained.length} of ${domains.length} recorded domain(s) appear nowhere in the diff — the diff alone cannot explain them.`)
} else if (profile) {
  out.push("No outbound domains were recorded for this run.")
} else {
  out.push("No execution record was available for this run (sensor profile missing) — absence of evidence, not a clean run.")
}
out.push("")
out.push("Cross-check against the **Garnet Runtime Review** comment on this PR (process lineage + destinations, per job) before finalizing a review.")
if (process.env.HEAD_SHA) {
  out.push("")
  out.push(`<sub>Head \`${process.env.HEAD_SHA.slice(0, 12)}\`${repoLabel ? ` · ${repoLabel}` : ""} · rendered by \`.github/scripts/coverage-gap.mjs\`</sub>`)
}
console.log(out.join("\n"))

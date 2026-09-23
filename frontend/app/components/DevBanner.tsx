import { execSync } from "child_process";
import { statSync } from "fs";

// Dev-only sanity banner: shows the git branch, the last change (commit subject +
// relative time), a per-change build ID, and the server render time — so you can
// confirm the running app reflects the code you expect. The ID + banner color are
// derived from the newest modified source file: they stay stable across page
// refreshes but flip the instant you save code, giving a visual "the reload landed"
// cue. Renders nothing in production. Server Component: git is read at render time.

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Epoch (ms) of the most recent code change: newest mtime among working-tree changes
// if dirty, else the HEAD commit time. This is what makes the ID/color change on save.
function latestChangeEpoch(dirtyStatus: string): number {
  if (dirtyStatus) {
    let max = 0;
    for (const line of dirtyStatus.split("\n")) {
      // porcelain v1: "XY path" — take everything after the status + space; for renames
      // ("R  old -> new") use the destination.
      const raw = line.slice(3).trim();
      const path = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
      try {
        const m = statSync(path.replace(/^"|"$/g, "")).mtimeMs;
        if (m > max) max = m;
      } catch {
        /* file may be deleted/renamed — skip */
      }
    }
    if (max > 0) return Math.floor(max);
  }
  const ct = parseInt(git("log -1 --format=%ct"), 10);
  return Number.isFinite(ct) ? ct * 1000 : Date.now();
}

// Deterministic hue from the ID: same code state → same color, a new state → a
// (very likely) different color.
function hueFrom(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export default function DevBanner() {
  if (process.env.NODE_ENV === "production") return null;

  const branch = git("rev-parse --abbrev-ref HEAD") || "unknown";
  const subject = git("log -1 --format=%s") || "no commits";
  const when = git("log -1 --format=%cr") || "";
  const dirtyStatus = git("status --porcelain");
  const dirty = dirtyStatus.length > 0;
  const loadedAt = new Date().toLocaleTimeString();

  const buildId = latestChangeEpoch(dirtyStatus).toString(36).slice(-6);
  const bg = `hsl(${hueFrom(buildId)}, 70%, 40%)`;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 2147483647,
        pointerEvents: "none",
        background: bg,
        color: "#fff",
        font: "500 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
        letterSpacing: "0.02em",
        padding: "3px 10px",
        display: "flex",
        gap: "10px",
        alignItems: "center",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        boxShadow: "0 -1px 6px rgba(0,0,0,0.25)",
      }}
    >
      <span style={{ fontWeight: 700 }}>DEV</span>
      <span
        style={{
          fontWeight: 700,
          background: "rgba(0,0,0,0.28)",
          borderRadius: 4,
          padding: "0 6px",
        }}
      >
        #{buildId}
      </span>
      <span style={{ opacity: 0.85 }}>│</span>
      <span>🌿 {branch}{dirty ? " ✎uncommitted" : ""}</span>
      <span style={{ opacity: 0.85 }}>│</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        📝 {subject}{when ? ` (${when})` : ""}
      </span>
      <span style={{ opacity: 0.85 }}>│</span>
      <span>⏱ loaded {loadedAt}</span>
    </div>
  );
}

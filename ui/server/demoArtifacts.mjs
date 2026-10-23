import fs from "node:fs";
import path from "node:path";

const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeDemoSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug) && !slug.includes("..");
}

function atomicWrite(finalPath, contents) {
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.demo.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, finalPath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end);
  const data = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: raw.slice(end + 5) };
}

function stringifyFrontmatter(data, body) {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

/** Readable synthetic receipt — not a blank 1×1 PNG. Safe SVG for `<img>` evidence. */
export function buildDemoReceiptSvg({ slug, title, company, submittedAt }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200" role="img" aria-label="Demo application receipt">
  <rect width="100%" height="100%" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="24" y="40" font-family="system-ui, sans-serif" font-size="20" font-weight="600" fill="#0f172a">Demo application receipt</text>
  <text x="24" y="72" font-family="system-ui, sans-serif" font-size="14" fill="#b45309">Synthetic — not sent to any employer</text>
  <text x="24" y="104" font-family="ui-monospace, monospace" font-size="13" fill="#334155">${escapeXml(title)} · ${escapeXml(company)}</text>
  <text x="24" y="132" font-family="ui-monospace, monospace" font-size="12" fill="#64748b">slug: ${escapeXml(slug)}</text>
  <text x="24" y="156" font-family="ui-monospace, monospace" font-size="12" fill="#64748b">${escapeXml(submittedAt)}</text>
</svg>`;
}

function rollbackCommit(root, slug, committed, stateBackup) {
  const appliedPath = path.join(root, "jobs", "applied", `${slug}.md`);
  const screenshotPath = path.join(root, "screenshots", `demo-synthetic-${slug}-confirmation.svg`);
  const statePath = path.join(root, "state.json");
  if (committed.state) {
    fs.writeFileSync(statePath, stateBackup);
  }
  if (committed.screenshot) {
    try { fs.rmSync(screenshotPath, { force: true }); } catch {}
  }
  if (committed.applied) {
    try { fs.rmSync(appliedPath, { force: true }); } catch {}
  }
}

export function persistDemoScores(root) {
  const dir = path.join(root, "jobs", "discovered");
  if (!fs.existsSync(dir)) return 0;
  const stamp = new Date().toISOString();
  let updated = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, "utf8");
    const { data, body } = parseFrontmatter(raw);
    if (data.llm_score != null && data.llm_score !== "") continue;
    const score = name.includes("analyst") ? 2 : name.includes("designer") ? 3 : 4;
    data.llm_score = String(score);
    data.llm_reasoning = "Synthetic demo score — not from a live model.";
    data.llm_scored_at = stamp;
    data.demo = "true";
    atomicWrite(file, stringifyFrontmatter(data, body));
    updated += 1;
  }
  return updated;
}

/**
 * Commit a demo application atomically with rollback on failure.
 * Queue file is removed only after all artifacts + state succeed.
 * @param {{ injectFailureAfter?: "applied" | "screenshot" | "state" | "queue" }} [options]
 */
export function commitDemoApplication(root, slug, options = {}) {
  if (!isSafeDemoSlug(slug)) throw new Error("invalid slug");
  const queuePath = path.join(root, "jobs", "queue", `${slug}.md`);
  const appliedPath = path.join(root, "jobs", "applied", `${slug}.md`);
  if (!fs.existsSync(queuePath)) throw new Error("queue item missing");
  if (fs.existsSync(appliedPath)) throw new Error("application already exists");

  const queueRaw = fs.readFileSync(queuePath, "utf8");
  const { data: queueData, body } = parseFrontmatter(queueRaw);
  const now = new Date().toISOString();
  const screenshotRel = `screenshots/demo-synthetic-${slug}-confirmation.svg`;
  const screenshotPath = path.join(root, screenshotRel);
  const appliedRel = `jobs/applied/${slug}.md`;

  const title = queueData.title ?? slug;
  const company = queueData.company ?? "Example Company";

  const appliedData = {
    ...queueData,
    demo: "true",
    demo_label: "Synthetic demo submission — not sent to any employer",
    status: "submitted",
    applied_at: now,
    submitted_at: now,
    screenshot: screenshotRel,
  };
  const appliedBody = body.trim().length > 0
    ? body
    : "Synthetic demo application artifact — not submitted to any employer.\n";

  const statePath = path.join(root, "state.json");
  const stateBackup = fs.readFileSync(statePath);
  const state = JSON.parse(stateBackup.toString("utf8"));
  if ((state.applications ?? []).some((entry) => entry.slug === slug)) {
    throw new Error("application already tracked");
  }

  const appliedTmp = path.join(root, "jobs", "applied", `.demo-applied.${process.pid}.${Date.now()}.tmp`);
  const shotTmp = path.join(root, "screenshots", `.demo-shot.${process.pid}.${Date.now()}.tmp`);
  const stateTmp = path.join(root, `.demo-state.${process.pid}.${Date.now()}.tmp`);
  const temps = [appliedTmp, shotTmp, stateTmp];
  const committed = { applied: false, screenshot: false, state: false };

  try {
    fs.mkdirSync(path.dirname(appliedTmp), { recursive: true });
    fs.writeFileSync(appliedTmp, stringifyFrontmatter(appliedData, appliedBody));

    fs.mkdirSync(path.dirname(shotTmp), { recursive: true });
    fs.writeFileSync(
      shotTmp,
      buildDemoReceiptSvg({ slug, title, company, submittedAt: now }),
      "utf8",
    );

    const nextState = {
      ...state,
      applications: [...(state.applications ?? []), {
        slug,
        status: "submitted",
        url: queueData.url ?? `https://example.invalid/jobs/${slug}`,
        company,
        title,
        location_raw: queueData.location ?? "Remote",
        resume_key: "default",
        queue_file: appliedRel,
        attempts: [{
          started_at: now,
          ended_at: now,
          outcome: "submitted",
          notes: "Demo synthetic submission — not sent to any employer.",
        }],
        screenshot: screenshotRel,
        submitted_at: now,
        confirmation_source: "demo",
      }],
      last_updated: now,
    };
    fs.writeFileSync(stateTmp, `${JSON.stringify(nextState, null, 2)}\n`);

    fs.renameSync(appliedTmp, appliedPath);
    temps.splice(temps.indexOf(appliedTmp), 1);
    committed.applied = true;
    if (options.injectFailureAfter === "applied") throw new Error("injected failure after applied");

    fs.renameSync(shotTmp, screenshotPath);
    temps.splice(temps.indexOf(shotTmp), 1);
    committed.screenshot = true;
    if (options.injectFailureAfter === "screenshot") throw new Error("injected failure after screenshot");

    fs.renameSync(stateTmp, statePath);
    temps.splice(temps.indexOf(stateTmp), 1);
    committed.state = true;
    if (options.injectFailureAfter === "state") throw new Error("injected failure after state");

    fs.unlinkSync(queuePath);
    if (options.injectFailureAfter === "queue") throw new Error("injected failure after queue");
  } catch (error) {
    rollbackCommit(root, slug, committed, stateBackup);
    throw error;
  } finally {
    for (const tmp of temps) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  }

  return { screenshotRel, appliedPath: appliedRel };
}

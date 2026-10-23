import fs from "node:fs";
import path from "node:path";
import { DEMO_CONNECTION_ID } from "./demo-constants.mjs";

export { DEMO_CONNECTION_ID };

const DEMO_ACK_AT = "2026-01-01T00:00:00.000Z";

export function demoProfile(template) {
  let md = template
    .replaceAll("<FILL IN>", (match, offset, whole) => {
      const line = whole.slice(whole.lastIndexOf("\n", offset) + 1, whole.indexOf("\n", offset));
      if (line.includes("Full name")) return "Demo Applicant";
      if (line.includes("Preferred name")) return "Demo";
      if (line.includes("Email")) return "demo.applicant@example.invalid";
      if (line.includes("Phone")) return "555-010-0999";
      if (line.includes("LinkedIn")) return "https://linkedin.com/in/demo-applicant";
      if (line.includes("Pronouns")) return "they/them";
      if (line.includes("Citizenship")) return "US citizen";
      if (line.includes("Visa sponsorship")) return "No";
      if (line.includes("Security clearance")) return "None";
      if (line.includes("years total")) return "10";
      if (line.includes("Notice period")) return "2 weeks";
      if (line.includes("Willingness to relocate")) return "Open";
      if (line.includes("travel")) return "10%";
      if (line.includes("Remote / hybrid")) return "Remote";
      if (line.includes("Years of experience (overall)")) return "10";
      if (line.includes("per stack")) return "TypeScript 8";
      if (line.includes("Referral")) return "Company site";
      if (line.includes("hear about")) return "Job board";
      if (line.includes("Target roles:")) return "product engineer";
      if (line.includes("Target level:")) return "senior";
      if (line.includes("Target locations:")) return "remote";
      if (line.includes("Education:")) return "BS Computer Science";
      return "Demo value";
    });
  const literal = {
    "<FILL IN name>": "Demo Applicant",
    "<FILL IN current title and company>": "Staff Engineer at Demo Co",
    "<FILL IN prior roles>": "Engineer at Example Inc",
    "<FILL IN stack>": "TypeScript, React, Node",
    "<FILL IN — a paragraph you'd be happy to submit unedited>": "Demo applicant summary paragraph.",
    "<FILL IN — e.g. product designer, design systems, staff engineer>": "product engineer",
    "<FILL IN — e.g. senior, staff, director>": "senior",
    "<Job title>": "Staff Engineer",
    "<Company>": "Demo Co",
    "<YYYY-MM>": "2020-01",
    "<One-paragraph summary of the role.>": "Built demo systems.",
    "<Project or theme>": "Platform",
    "<what you did and what it produced>": "shipped reliable services",
    "<Previous job title>": "Engineer",
    "<Accomplishment.>": "Delivered features on schedule.",
    "<Degree>": "BS",
    "<Institution>": "Demo University",
    "<Honors, GPA, or other detail — delete if not applicable>": "Graduated with honors",
    "<Two or three sentences about what you want to work on and why this kind of company. >":
      "I want to build reliable tools. [COMPANY] looks like a strong fit.",
  };
  for (const [from, to] of Object.entries(literal)) md = md.replaceAll(from, to);
  md = md.replace(
    /<Two or three sentences[\s\S]*?\[COMPANY\][\s\S]*?>/g,
    "I want to build reliable tools. [COMPANY] looks like a strong fit.",
  );
  return md;
}

function demoResumePdf(codeRoot) {
  const fixture = path.join(codeRoot, "ui", "e2e", "fixtures", "sample.pdf");
  if (fs.existsSync(fixture)) return fs.readFileSync(fixture);
  return Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
}

export function seedPopulatedDemoWorkspace(demoRoot, codeRoot) {
  const profileTemplate = fs.readFileSync(path.join(codeRoot, "templates", "profile.template.md"), "utf8");
  fs.writeFileSync(path.join(demoRoot, "profile.md"), demoProfile(profileTemplate));
  fs.writeFileSync(
    path.join(demoRoot, "targets.md"),
    fs.readFileSync(path.join(codeRoot, "templates", "targets.template.md"), "utf8").replaceAll("example-co", "demo-co"),
  );
  fs.writeFileSync(
    path.join(demoRoot, "settings.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      connections: [{
        id: DEMO_CONNECTION_ID,
        label: "Demo Local Provider",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
      }],
      agent: { connectionId: DEMO_CONNECTION_ID, modelId: "demo-model" },
      scoring: null,
      captcha: { provider: "off", api_key: "" },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(demoRoot, "gather_state.json"),
    `${JSON.stringify({ seen_urls: {}, per_company: {}, auto_promote: false }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(demoRoot, "state.json"),
    `${JSON.stringify({
      acknowledged_at: DEMO_ACK_AT,
      acknowledged_policy: "auto-submit-v1",
      addresses: {
        denver: { street: "100 Demo St", city: "Denver", state: "CO", zip: "80202" },
      },
      applications: [],
      last_updated: DEMO_ACK_AT,
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(demoRoot, "resumes", "default.pdf"), demoResumePdf(codeRoot));
  for (const [slug, title] of [
    ["example-role", "Product Engineer"],
    ["example-designer", "Product Designer"],
    ["example-analyst", "Business Analyst"],
  ]) {
    fs.writeFileSync(
      path.join(demoRoot, "jobs", "discovered", `${slug}.md`),
      `---\ndemo: true\nurl: https://example.invalid/jobs/${slug}\ncompany: Example Company\ntitle: ${title}\nlocation: Remote\nsource: greenhouse\ndiscovered_at: 2026-01-01T00:00:00.000Z\n---\nSynthetic posting. Demo mode never contacts this URL.\n`,
    );
  }
  fs.writeFileSync(
    path.join(demoRoot, "jobs", "queue", "demo-queued-role.md"),
    `---\ndemo: true\nurl: https://example.invalid/jobs/queued\ncompany: Example Company\ntitle: Queued Demo Role\nlocation: Remote\nsource: greenhouse\n---\nSynthetic queued job for supervised demo runs.\n`,
  );
  fs.mkdirSync(path.join(demoRoot, ".pi-jobs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(demoRoot, ".pi-jobs", "demo-mode.json"),
    `${JSON.stringify({ mode: "populated", label: "Synthetic demo workspace — no external calls" }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function demoSeedPaths(codeRoot) {
  return {
    resumeFixture: path.join(codeRoot, "ui", "e2e", "fixtures", "sample.pdf"),
  };
}

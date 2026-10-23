import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const amplitudeJob = JSON.parse(
  fs.readFileSync(
    path.join(root, ".pi/extensions/lib/adapters/__fixtures__/amplitude-8654510002.json"),
    "utf8",
  ),
);

const fictionalGreenhouseJob = {
  id: 8000000001,
  title: "Staff Platform Engineer",
  absolute_url: "https://job-boards.example.invalid/fictional-greenhouse/jobs/8000000001",
  location: { name: "Remote" },
  content: "<p>Fictional greenhouse posting for gather tests.</p>",
  first_published: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  departments: amplitudeJob.departments,
  offices: amplitudeJob.offices,
};

const fictionalAshbyJob = {
  id: "fictional-ashby-role-1",
  title: "Fictional Ashby Analyst",
  location: "Remote",
  jobUrl: "https://jobs.example.invalid/fictional-ashby/fictional-ashby-role-1",
  descriptionPlain: "Fictional ashby posting for gather tests.",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

const fictionalLeverJob = {
  id: "fictional-lever-role-1",
  text: "Fictional Lever Designer",
  hostedUrl: "https://jobs.example.invalid/fictional-lever/fictional-lever-role-1",
  categories: { location: "Remote", team: "Design" },
  descriptionPlain: "Fictional lever posting for gather tests.",
  createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
};

const boards = {
  "fictional-greenhouse": {
    jobs: [fictionalGreenhouseJob],
    meta: { total: 1 },
  },
  "fictional-ashby": {
    jobs: [fictionalAshbyJob],
  },
  "fictional-lever": [fictionalLeverJob],
};

export function createAtsJsonFixtureServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const matchGreenhouse = url.pathname.match(/^\/v1\/boards\/([^/]+)\/jobs$/);
    if (req.method === "GET" && matchGreenhouse) {
      const slug = matchGreenhouse[1];
      const payload = boards[slug];
      if (!payload || !payload.jobs) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
      return;
    }

    const matchAshby = url.pathname.match(/^\/posting-api\/job-board\/([^/]+)$/);
    if (req.method === "GET" && matchAshby) {
      const slug = matchAshby[1];
      const payload = boards[slug];
      if (!payload?.jobs) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jobs: payload.jobs }));
      return;
    }

    const matchLever = url.pathname.match(/^\/v0\/postings\/([^/]+)$/);
    if (req.method === "GET" && matchLever && url.searchParams.get("mode") === "json") {
      const slug = matchLever[1];
      const payload = boards[slug];
      if (!Array.isArray(payload)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

export function listenAtsJsonFixtureServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export function closeAtsJsonFixtureServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

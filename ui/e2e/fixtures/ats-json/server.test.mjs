import assert from "node:assert/strict";
import test from "node:test";
import { closeAtsJsonFixtureServer, createAtsJsonFixtureServer, listenAtsJsonFixtureServer } from "./server.mjs";

test("ATS JSON fixture serves gatherer board paths", async () => {
  const server = createAtsJsonFixtureServer();
  await listenAtsJsonFixtureServer(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const greenhouse = await fetch(
    `${base}/v1/boards/fictional-greenhouse/jobs?content=true`,
  );
  assert.equal(greenhouse.status, 200);
  const gh = await greenhouse.json();
  assert.ok(Array.isArray(gh.jobs) && gh.jobs.length > 0);
  assert.equal(gh.meta?.total, gh.jobs.length);

  const ashby = await fetch(`${base}/posting-api/job-board/fictional-ashby`);
  assert.equal(ashby.status, 200);
  const ab = await ashby.json();
  assert.ok(Array.isArray(ab.jobs) && ab.jobs.length > 0);

  const lever = await fetch(`${base}/v0/postings/fictional-lever?mode=json`);
  assert.equal(lever.status, 200);
  const lv = await lever.json();
  assert.ok(Array.isArray(lv) && lv.length > 0);

  await closeAtsJsonFixtureServer(server);
});

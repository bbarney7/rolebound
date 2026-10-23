import http from "node:http";

const JOB_ID = "1234567";
const BOARD = "https://boards.example.invalid";

function greenhousePage(scenario) {
  const jobUrl = `${BOARD}/boards/fixture/jobs/${JOB_ID}?scenario=${encodeURIComponent(scenario)}`;
  const wrongUrl = `${BOARD}/boards/fixture/jobs/9999999?scenario=wrong`;
  const url = scenario === "wrong-page" ? wrongUrl : jobUrl;
  const already =
    scenario === "already-confirmed"
      ? `<p>Thank you for applying. We have received your application.</p>`
      : `<p>Apply for this role at Fixture Co.</p>`;
  const captcha =
    scenario === "captcha"
      ? `<iframe src="https://example.invalid/hcaptcha-box"></iframe><p>Verify you are human</p>`
      : "";
  const form =
    scenario === "already-confirmed" || scenario === "captcha"
      ? ""
      : `<form id="application-form">
           <input id="first_name" name="first_name" />
           <button type="button" id="submit-btn">Submit application</button>
         </form>`;
  return `<!DOCTYPE html>
<html><head><title>Fixture job ${JOB_ID}</title></head>
<body>
  <script>window.__SCENARIO__="${scenario}";window.__JOB_URL__="${url}";</script>
  ${already}${captcha}${form}
  <script>
    const scenario = window.__SCENARIO__;
    const btn = document.getElementById('submit-btn');
    if (btn) {
      btn.addEventListener('click', async () => {
        const r = await fetch('/submit?scenario=' + encodeURIComponent(scenario), { method: 'POST' });
        const j = await r.json();
        if (j.next === 'validation') {
          document.body.innerHTML += '<input id="req" aria-invalid="true" aria-errormessage="req-err" /><p id="req-err" class="field-error">Required field missing</p>';
        } else if (j.next === 'otp') {
          document.querySelector('form')?.remove();
          document.body.innerHTML += '<p>Enter the security code we emailed you.</p>' +
            Array.from({length:8}, () => '<input maxlength="1" />').join('') +
            '<button type="button" id="submit-btn">Submit application</button>';
          document.getElementById('submit-btn').addEventListener('click', async () => {
            const r2 = await fetch('/submit?scenario=' + encodeURIComponent(scenario), { method: 'POST' });
            const j2 = await r2.json();
            if (j2.next === 'success') {
              document.body.innerHTML += '<p>Thank you for applying. We have received your application.</p>';
            }
          });
        } else if (j.next === 'captcha') {
          document.querySelector('form')?.remove();
          document.body.innerHTML += '<iframe src="https://example.invalid/recaptcha"></iframe><p>Verify you are human</p>';
        } else if (j.next === 'success') {
          document.querySelector('form')?.remove();
          document.body.innerHTML += '<p>Thank you for applying. We have received your application.</p>';
        } else if (j.next === 'unknown') {
          document.querySelector('form')?.remove();
          document.body.innerHTML = '<p>Session expired. Please start over.</p>';
        }
      });
    }
  </script>
</body></html>`;
}

function genericPage(mode) {
  const body =
    mode === "enter"
      ? `<form id="generic-form" action="/submit?scenario=generic-${mode}" method="post">
           <input name="field" value="x" />
           <button type="submit" id="generic-submit">Apply now</button>
         </form>
         <script>
           document.getElementById('generic-form').addEventListener('submit', (e) => {
             e.preventDefault();
             fetch('/submit?scenario=generic-${mode}', { method: 'POST' }).then(() => {
               document.body.innerHTML = '<p>Generic submitted</p>';
             });
           });
         </script>`
      : mode === "js-submit"
        ? `<form id="generic-form">
             <input name="field" value="x" />
             <button type="button" id="generic-submit">Apply now</button>
           </form>
           <script>
             document.getElementById('generic-submit').addEventListener('click', () => {
               document.getElementById('generic-form').requestSubmit();
             });
             document.getElementById('generic-form').addEventListener('submit', (e) => {
               e.preventDefault();
               fetch('/submit?scenario=generic-${mode}', { method: 'POST' });
             });
           </script>`
        : `<form id="generic-form" action="/submit?scenario=generic-button" method="post">
             <input name="field" value="x" />
             <button type="submit" id="generic-submit">Apply now</button>
           </form>
           <script>
             document.getElementById('generic-form').addEventListener('submit', (e) => {
               e.preventDefault();
               fetch('/submit?scenario=generic-button', { method: 'POST' }).then(() => {
                 document.body.innerHTML = '<p>Generic submitted</p>';
               });
             });
           </script>`;
  return `<!DOCTYPE html><html><head><title>Generic ${mode}</title></head><body>${body}</body></html>`;
}

/** @type {Map<string, number>} */
const submitCounts = new Map();

function bump(scenario) {
  submitCounts.set(scenario, (submitCounts.get(scenario) ?? 0) + 1);
}

function nextForScenario(scenario) {
  const count = submitCounts.get(scenario) ?? 0;
  if (scenario === "success") return "success";
  if (scenario === "validation") return "validation";
  if (scenario === "otp") return count === 1 ? "otp" : "success";
  if (scenario === "captcha") return "captcha";
  if (scenario === "unknown") return "unknown";
  if (scenario.startsWith("generic")) return "success";
  return "success";
}

export function createAtsFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", BOARD);
    if (req.method === "GET" && url.pathname === "/counts") {
      const scenario = url.searchParams.get("scenario") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count: submitCounts.get(scenario) ?? 0 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      submitCounts.clear();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      const scenario = url.searchParams.get("scenario") ?? "default";
      bump(scenario);
      const next = nextForScenario(scenario);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ next, count: submitCounts.get(scenario) ?? 0 }));
      return;
    }
    if (req.method === "GET" && url.pathname === `/boards/fixture/jobs/${JOB_ID}`) {
      const scenario = url.searchParams.get("scenario") ?? "success";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(greenhousePage(scenario));
      return;
    }
    if (req.method === "GET" && url.pathname === "/boards/fixture/jobs/9999999") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(greenhousePage("wrong-page"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/generic/button") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(genericPage("button"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/generic/enter") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(genericPage("enter"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/generic/js-submit") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(genericPage("js-submit"));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return { server, boardOrigin: BOARD, jobId: JOB_ID };
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

export function boardUrl(server, pathSuffix, scenario) {
  const port = server.address().port;
  const q = scenario ? `?scenario=${encodeURIComponent(scenario)}` : "";
  return `http://127.0.0.1:${port}${pathSuffix}${q}`;
}

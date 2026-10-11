// Tests for sendops push (SND-1510).
//
// Every case runs the real script as a subprocess against a real HTTP server,
// because the two things worth testing here are exactly the two a unit test of
// the helpers would skip: the bytes that leave the process, and the exit code
// that reaches the pipeline. A pipeline reads nothing else.
//
// Node no longer walks a bare directory argument (it did up to v20), so the
// invocation is a glob the shell expands:
//
//   node --test sendops-push/test/*.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "push.mjs");
const FIXTURE = join(here, "fixtures", "bundle");

// ── the fake API ────────────────────────────────────────────────────────────

// The server records what it was sent and replies with whatever the current
// test set. One server for the file so each test is a payload and an
// assertion, not a lifecycle.
let server;
let baseUrl;
let received;
let reply;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        json: (() => {
          try {
            return JSON.parse(body);
          } catch {
            return undefined;
          }
        })(),
      };
      res.writeHead(reply.status, { "Content-Type": reply.contentType ?? "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

beforeEach(() => {
  received = undefined;
  reply = { status: 200, body: okResult([]) };
});

// ── helpers ─────────────────────────────────────────────────────────────────

function okResult(objects, extra = {}) {
  const totals = {};
  for (const o of objects) totals[o.action] = (totals[o.action] ?? 0) + 1;
  return {
    dry_run: false,
    plan: { applicable: true, prune: false, objects, totals, diagnostics: [] },
    applied: true,
    objects,
    ...extra,
  };
}

// runPush executes the script the way the Action does — configuration through
// the environment — and returns everything a caller can observe.
function runPush({ dir = FIXTURE, env = {}, args = [] } = {}) {
  const summaryFile = join(mkdtempSync(join(tmpdir(), "sendops-summary-")), "summary.md");
  const outputFile = join(dirname(summaryFile), "output.txt");
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH,
      SENDOPS_DIR: dir,
      SENDOPS_API_KEY: "sk_test_key",
      SENDOPS_API_URL: baseUrl,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  return new Promise((resolve) => {
    child.on("close", (code) => {
      const read = (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      };
      resolve({ code, stdout, stderr, summary: read(summaryFile), outputs: read(outputFile) });
    });
  });
}

// ── the request body ────────────────────────────────────────────────────────

test("sends the JSON import form: manifest object, text files, base64 images", async () => {
  reply = {
    status: 200,
    body: okResult([
      { kind: "template", key: "welcome", action: "create", diagnostics: [] },
      { kind: "segment", key: "all-contacts", action: "create", diagnostics: [] },
    ]),
  };

  const run = await runPush({ env: { SENDOPS_DRY_RUN: "true" } });
  assert.equal(run.code, 0, run.stderr);

  assert.equal(received.method, "POST");
  assert.equal(received.headers.authorization, "Bearer sk_test_key");
  assert.match(received.headers["content-type"], /application\/json/);

  const sent = received.json;
  // The manifest travels parsed, not as a string in `files`.
  assert.equal(typeof sent.manifest, "object");
  assert.ok(sent.manifest.templates.welcome, "manifest carries the templates block");
  assert.equal(sent.files["sendops.json"], undefined, "sendops.json is not duplicated into files");

  // Text files verbatim.
  assert.equal(typeof sent.files["templates/welcome.html"], "string");
  assert.match(sent.files["templates/welcome.html"], /welcome aboard/);
  assert.equal(sent.files["audience/all-contacts.sendql"], "count(send within 30d) >= 0\n");

  // Images base64, round-tripping to the bytes on disk.
  const encoded = sent.images["static/logo.png"];
  assert.equal(typeof encoded, "string");
  assert.deepEqual(
    Buffer.from(encoded, "base64"),
    readFileSync(join(FIXTURE, "static", "logo.png")),
    "the image decodes back to the file's bytes",
  );
  assert.equal(sent.files["static/logo.png"], undefined, "an image never lands in files");
});

test("puts dry_run and prune in the query string", async () => {
  await runPush({ env: { SENDOPS_DRY_RUN: "true" } });
  assert.equal(received.url, "/v1/import?dry_run=true&prune=false");

  await runPush({ env: { SENDOPS_DRY_RUN: "false", SENDOPS_PRUNE: "true" } });
  assert.equal(received.url, "/v1/import?dry_run=false&prune=true");

  // CLI flags override the environment, which is how `npx @sendops/push` works.
  await runPush({ env: { SENDOPS_DRY_RUN: "false" }, args: ["--dry-run", "--prune"] });
  assert.equal(received.url, "/v1/import?dry_run=true&prune=true");
});

test("refuses a directory with no sendops.json, without calling the API", async () => {
  const empty = mkdtempSync(join(tmpdir(), "sendops-empty-"));
  writeFileSync(join(empty, "notes.txt"), "nothing to see");
  const run = await runPush({ dir: empty });
  rmSync(empty, { recursive: true, force: true });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /has no sendops\.json at its root/);
  assert.equal(received, undefined, "nothing was sent");
});

// ── the summary ─────────────────────────────────────────────────────────────

test("prints a Markdown table to the job summary and to stdout", async () => {
  reply = {
    status: 200,
    body: okResult([
      { kind: "template", key: "welcome", action: "create", deploy_state: "deployed", diagnostics: [] },
      { kind: "segment", key: "all-contacts", action: "update", member_count: 42, diagnostics: [] },
      { kind: "list", key: "beta", action: "unchanged", diagnostics: [] },
    ]),
  };

  const run = await runPush();
  assert.equal(run.code, 0, run.stderr);

  for (const text of [run.summary, run.stdout]) {
    assert.match(text, /## SendOps push — apply/);
    assert.match(text, /\| Kind \| Key \| Action \| Deploy \| Members \| Notes \|/);
    assert.match(text, /\| template \| welcome \| create \| deployed \| {2}\| {2}\|/);
    assert.match(text, /\| segment \| all-contacts \| update \| {2}\| 42 \| {2}\|/);
    assert.match(text, /\*\*2 changes\*\* \(create 1, unchanged 1, update 1\)/);
  }

  assert.match(run.outputs, /^changes=2$/m);
  assert.match(run.outputs, /^applicable=true$/m);
});

test("an unchanged tree is 0 changes and exit 0", async () => {
  reply = {
    status: 200,
    body: okResult([
      { kind: "template", key: "welcome", action: "unchanged", diagnostics: [] },
      { kind: "segment", key: "all-contacts", action: "unchanged", diagnostics: [] },
    ]),
  };

  const run = await runPush();
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.summary, /\*\*0 changes\.\*\* Every object in the bundle matches what SendOps already has\./);
  assert.match(run.outputs, /^changes=0$/m);
});

// ── the failure modes ───────────────────────────────────────────────────────

test("applicable: false exits 1 and shows the diagnostic with line and column", async () => {
  reply = {
    status: 200,
    body: {
      dry_run: true,
      plan: {
        applicable: false,
        prune: false,
        objects: [
          {
            kind: "workflow",
            key: "onboarding",
            path: "audience/workflows/onboarding.flow",
            action: "update",
            diagnostics: [
              {
                path: "audience/workflows/onboarding.flow",
                line: 12,
                column: 3,
                message: 'unexpected token "wait"',
              },
            ],
          },
        ],
        totals: { update: 1 },
        diagnostics: [],
      },
      applied: false,
      objects: [],
    },
  };

  const run = await runPush({ env: { SENDOPS_DRY_RUN: "true" } });
  assert.equal(run.code, 1);
  assert.match(run.summary, /audience\/workflows\/onboarding\.flow:12:3: unexpected token "wait"/);
  assert.match(run.summary, /The bundle is not applicable — nothing was written\./);
  assert.match(run.outputs, /^applicable=false$/m);
});

test("a failed template deploy exits 1", async () => {
  reply = {
    status: 200,
    body: okResult([
      {
        kind: "template",
        key: "welcome",
        action: "update",
        deploy_state: "failed",
        error: "SES rejected the template: invalid handlebars",
        diagnostics: [],
      },
    ]),
  };

  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.summary, /Template welcome failed to deploy to SES: SES rejected the template/);
});

test("a partial apply exits 1 and names where it stopped", async () => {
  reply = {
    status: 200,
    body: okResult([{ kind: "list", key: "beta", action: "create", diagnostics: [] }], {
      applied: false,
      applied_until: "list",
      error: "segment all-contacts: predicate references an unknown attribute",
    }),
  };

  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.summary, /The import stopped before finishing after list: segment all-contacts/);
});

test("a 403 exits 1 and names the missing scope", async () => {
  reply = {
    status: 403,
    body: {
      type: "about:blank",
      title: "Insufficient scope",
      status: 403,
      code: "invalid_scope",
      detail: 'API key lacks required scope "api.workflows.manage".',
      scope: "api.workflows.manage",
      request_id: "req_123",
    },
  };

  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 403: Insufficient scope/);
  assert.match(run.stderr, /Missing scope: api\.workflows\.manage — add it to the API key and re-run\./);
  assert.match(run.stderr, /Request id: req_123/);
  assert.match(run.summary, /SendOps push — failed/);
});

test("an error in the dashboard envelope still prints its code and message", async () => {
  // What every push from an org with no contact list got before the server
  // answered in problem+json: the reason was in error.message and push printed
  // only "HTTP 404: Request failed".
  reply = {
    status: 404,
    body: { error: { code: "not_found", message: "Not found" } },
  };

  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 404: not_found/);
  assert.match(run.stderr, /\nNot found/);
  assert.doesNotMatch(run.stderr, /Request failed/);
});

test("a 402 plan-limit refusal exits 1 with the upgrade line", async () => {
  // The /v1/import refusal (SND-1593): the standard plan_limit_exceeded
  // problem plus the bundle's plan_limit.
  reply = {
    status: 402,
    contentType: "application/problem+json",
    body: {
      type: "https://developers.sendops.dev/api-reference/errors/plan_limit_exceeded",
      title: "Plan limit exceeded",
      status: 402,
      code: "plan_limit_exceeded",
      detail: "plan limit reached: segments (3/3 on free plan)",
      limit_type: "segments",
      current: 3,
      limit: 3,
      would_add: 4,
      upgrade_url: "https://app.sendops.dev/acme/billing?reason=segments&upgrade=team",
      plan_limit: {
        axis: "segments",
        current: 0,
        limit: 3,
        would_be: 4,
        upgrade_url: "https://app.sendops.dev/acme/billing?reason=segments&upgrade=team",
      },
      request_id: "req_402",
    },
  };

  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(
    run.stderr,
    /Import refused: plan limit — segments 4\/3\. Upgrade: https:\/\/app\.sendops\.dev\/acme\/billing\?reason=segments&upgrade=team/,
  );
  assert.match(run.stderr, /HTTP 402: Plan limit exceeded/);
  assert.match(run.summary, /Import refused: plan limit — segments 4\/3/);
});

test("a 402 without plan_limit still prints the line from the standard fields", async () => {
  reply = {
    status: 402,
    body: {
      title: "Plan limit exceeded",
      status: 402,
      code: "plan_limit_exceeded",
      limit_type: "templates",
      current: 3,
      limit: 3,
      upgrade_url: "https://app.sendops.dev/billing?reason=templates",
    },
  };
  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Import refused: plan limit — templates 4\/3\. Upgrade: https:\/\/app\.sendops\.dev\/billing\?reason=templates/);
});

test("a dry run whose plan crosses a cap exits 1 with the upgrade line", async () => {
  reply = {
    status: 200,
    body: {
      dry_run: true,
      plan: {
        applicable: false,
        prune: false,
        objects: [{ kind: "segment", key: "vip", action: "create", diagnostics: [] }],
        totals: { create: 1 },
        diagnostics: [],
        plan_limit: { axis: "segments", current: 3, limit: 3, would_be: 4, upgrade_url: "https://app.sendops.dev/billing" },
      },
      objects: [],
    },
  };
  const run = await runPush({ env: { SENDOPS_DRY_RUN: "true" } });
  assert.equal(run.code, 1);
  assert.match(run.stdout, /Import refused: plan limit — segments 4\/3\. Upgrade: https:\/\/app\.sendops\.dev\/billing/);
  assert.doesNotMatch(run.stdout, /Fix the diagnostics/);
});

test("a non-JSON response exits 1", async () => {
  reply = { status: 200, contentType: "text/html", body: "<html>gateway</html>" };
  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the response was not JSON/);
  assert.match(run.stderr, /<html>gateway<\/html>/);
});

test("a missing API key exits 1 before any request", async () => {
  const run = await runPush({ env: { SENDOPS_API_KEY: "" } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /an API key is required/);
  assert.equal(received, undefined);
});

test("an unreachable API exits 1 naming the URL", async () => {
  // Port 1 is reserved and never listening.
  const run = await runPush({ env: { SENDOPS_API_URL: "http://127.0.0.1:1" } });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /could not reach http:\/\/127\.0\.0\.1:1\/v1\/import/);
});

test("skips dotfiles and node_modules when walking the directory", async () => {
  const copy = mkdtempSync(join(tmpdir(), "sendops-walk-"));
  writeFileSync(join(copy, "sendops.json"), '{"templates":{}}');
  mkdirSync(join(copy, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(copy, "node_modules", "junk", "index.js"), "module.exports = 1");
  mkdirSync(join(copy, ".git"), { recursive: true });
  writeFileSync(join(copy, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(copy, ".DS_Store"), "junk");
  mkdirSync(join(copy, "templates"), { recursive: true });
  writeFileSync(join(copy, "templates", "welcome.html"), "<p>hi</p>");

  const run = await runPush({ dir: copy });
  rmSync(copy, { recursive: true, force: true });

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(Object.keys(received.json.files), ["templates/welcome.html"]);
  assert.equal(received.json.images, undefined);
});

test("a 200 that is not an import result exits 1", async () => {
  // A proxy or SSO portal answering 200 with a page of its own. Reporting that
  // as an empty plan would go green having deployed nothing.
  reply = { status: 200, body: { hello: "world" } };
  const run = await runPush();
  assert.equal(run.code, 1);
  assert.match(run.stderr, /the response was not JSON/);
});

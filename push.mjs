#!/usr/bin/env node
// sendops push — send a rendered bundle to POST /v1/import (SND-1510).
//
// This is the step that replaces the git sync. A React Email team keeps its
// repo, its build and its review process; what changes is the last step. Where
// CI used to `git add sendops && git push` and wait for a webhook to tell
// SendOps that a folder in a repository it had been granted access to had
// changed, it now POSTs the rendered bundle straight at the API. SendOps never
// learns the repository exists.
//
// Three properties are the whole design:
//
//   1. Zero dependencies. Node 20's global `fetch` and the standard library are
//      all this uses. A customer's CI runner should not need a lockfile, a
//      registry, or an audit exception to deploy a template. That is also why
//      the bundle travels as the JSON form rather than as a zip: building a zip
//      without a library is possible but not worth the code, and the import
//      route takes either (see internal/manifest/bundle.go, JSONBundle).
//   2. Dry run is a first-class mode, not a debug flag. The documented recipe
//      runs this with `dry_run: true` on pull requests and `false` on merge, so
//      a reviewer sees the plan — including diagnostics positioned by line and
//      column — in the PR's checks before anybody applies it.
//   3. An unchanged tree is a no-op, end to end. The API answers an unchanged
//      push with every object `unchanged` and writes nothing; this script then
//      says "0 changes" and exits 0. Running it on every commit has to be
//      boring, or teams will start guarding it with `if` conditions that go
//      stale.
//
// Exit codes: 0 when the push succeeded (or the dry run is applicable), 1 for
// everything else — an inapplicable plan, a plan-limit refusal, a failed SES
// deploy, a partial apply, an HTTP error, a response that is not JSON. A pipeline reads the exit code;
// the summary explains it.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, relative, sep, extname, resolve } from "node:path";

// ── bounds ──────────────────────────────────────────────────────────────────
//
// These mirror manifest.MaxBundleFiles / MaxBundleFileBytes / MaxBundleBytes on
// the server. Duplicating them here is deliberate: the server's refusal is a
// 422 naming one entry, while a local check can name the directory, the file and
// the ceiling before a single byte crosses the network. The server's copy is
// still the one that counts — this one only makes the common mistake legible.
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

// MANIFEST_NAME is the one file a bundle must have, at its root. The zip form
// makes the same demand for the same reason: the manifest is what says which of
// the other files are templates, which are segments, and which are nothing.
const MANIFEST_NAME = "sendops.json";

// IMAGE_EXTENSIONS decides which map a file travels in. It mirrors
// jobs.imageExtensions, the allowlist the git path promotes to the Edge CDN.
//
// The server splits by UTF-8 validity rather than by extension, and accepts
// either map for either kind of file ("the names say what the ENCODING is, and
// the manifest says what the file IS"). Extension is the right test HERE
// because it is the one a script can apply without reading the bytes twice, and
// because it puts `.svg` — valid UTF-8, but an image by every other measure —
// where a human reading the request body expects to find it.
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".avif",
]);

// SKIP_DIRECTORIES are never walked. A bundle directory is usually generated,
// but it is generated INTO a git working tree, and `node_modules` next to a
// `sendops.json` is a mistake worth surviving rather than a 32 MiB upload.
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

const DEFAULT_API_URL = "https://api.sendops.dev";
const DEFAULT_DIR = "./sendops";

// Actions that mean something was written. `unchanged` is not a change (that is
// the point of the mode) and `skip` is the opposite of one: the API declined to
// touch an object and said why.
const CHANGE_ACTIONS = new Set(["create", "update", "archive", "delete"]);

const USAGE = `sendops push — push a SendOps bundle to POST /v1/import

Usage:
  sendops-push [--dir ./sendops] [--api-key sk_live_…] [--api-url https://api.sendops.dev]
               [--dry-run] [--prune]

Options:
  --dir <path>       Bundle directory; must contain sendops.json  (env SENDOPS_DIR)
  --api-key <key>    API key with the .manage scope of each kind  (env SENDOPS_API_KEY)
  --api-url <url>    API base URL                                 (env SENDOPS_API_URL)
  --dry-run[=bool]   Plan only, write nothing                     (env SENDOPS_DRY_RUN)
  --prune[=bool]     Archive/delete what the bundle omits         (env SENDOPS_PRUNE)
  -h, --help         This message

Exit code 0 when the push applied (or the dry run is applicable), 1 otherwise.
`;

// ── argument handling ───────────────────────────────────────────────────────

// parseArgs reads the flags. Values may be `--flag value` or `--flag=value`;
// the two boolean flags may also stand alone, so `--dry-run` means
// `--dry-run=true` the way every other CLI spells it.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    switch (name) {
      case "dir":
      case "api-key":
      case "api-url": {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) {
          throw new Error(`--${name} needs a value`);
        }
        out[name] = value;
        break;
      }
      case "dry-run":
      case "prune":
        out[name] = inlineValue === undefined ? true : parseBool(inlineValue, `--${name}`);
        break;
      default:
        throw new Error(`unknown flag --${name}`);
    }
  }
  return out;
}

// parseBool refuses what it does not understand rather than falling back to a
// default. A job that wrote `dry_run: no` meant something by it, and quietly
// reading that as "apply" is the worst available interpretation — the same
// stance the API's own boolParam takes.
export function parseBool(raw, what) {
  const v = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off", ""].includes(v)) return false;
  throw new Error(`${what} must be true or false, got ${JSON.stringify(raw)}`);
}

// resolveConfig layers CLI flags over environment variables over defaults.
//
// The GitHub Action passes its inputs as environment variables and nothing
// else, so env alone must be a complete configuration; the flags exist for
// `npx @sendops/push` on a laptop, and win where both are set.
export function resolveConfig(args, env) {
  const dir = args.dir ?? env.SENDOPS_DIR ?? DEFAULT_DIR;
  const apiKey = args["api-key"] ?? env.SENDOPS_API_KEY ?? "";
  const apiUrl = (args["api-url"] ?? env.SENDOPS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const dryRun =
    args["dry-run"] ?? (env.SENDOPS_DRY_RUN ? parseBool(env.SENDOPS_DRY_RUN, "SENDOPS_DRY_RUN") : false);
  const prune = args.prune ?? (env.SENDOPS_PRUNE ? parseBool(env.SENDOPS_PRUNE, "SENDOPS_PRUNE") : false);

  if (!apiKey) {
    throw new Error("an API key is required — pass --api-key or set SENDOPS_API_KEY");
  }
  if (!/^https?:\/\//i.test(apiUrl)) {
    throw new Error(`--api-url must be an http(s) URL, got ${JSON.stringify(apiUrl)}`);
  }
  return { dir, apiKey, apiUrl, dryRun, prune };
}

// ── reading the bundle ──────────────────────────────────────────────────────

// walk lists every file under root, depth first, as bundle-relative POSIX
// paths. Sorted, because a sorted body makes two pushes of the same tree
// byte-identical, which is what lets a human diff one request against another.
function walk(root) {
  const found = [];
  const visit = (absolute) => {
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        found.push(relative(root, child).split(sep).join("/"));
      }
      // Symlinks and everything else are skipped: a bundle is a set of files,
      // and following a link out of the directory is how a push ends up
      // carrying something nobody meant to publish.
    }
  };
  visit(root);
  return found;
}

// readBundle turns a directory into the JSON import form the API takes:
//
//   { manifest: {…}, files: { "path": "utf8" }, images: { "path": "base64" } }
//
// The manifest travels as a parsed OBJECT, not as a string in `files`. The
// server accepts both and prefers the object; sending it parsed means a
// malformed sendops.json fails here, naming the file, rather than 400 leagues
// downstream as "body is not a JSON bundle".
export function readBundle(dir) {
  const root = resolve(dir);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new Error(`bundle directory ${dir} does not exist`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`bundle path ${dir} is not a directory`);
  }

  const paths = walk(root);
  if (!paths.includes(MANIFEST_NAME)) {
    throw new Error(
      `${dir} has no ${MANIFEST_NAME} at its root — point --dir at the directory your exporter writes, not at its parent`,
    );
  }
  if (paths.length > MAX_FILES) {
    throw new Error(`${dir} holds ${paths.length} files, more than the ${MAX_FILES} a bundle may carry`);
  }

  const bundle = { manifest: undefined, files: {}, images: {} };
  let total = 0;
  let fileCount = 0;

  for (const path of paths) {
    const body = readFileSync(join(root, ...path.split("/")));
    if (body.length > MAX_FILE_BYTES) {
      throw new Error(`${path} is ${body.length} bytes, over the ${MAX_FILE_BYTES} byte per-file limit`);
    }
    total += body.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`${dir} is over the ${MAX_TOTAL_BYTES} byte bundle limit at ${path}`);
    }
    fileCount++;

    if (path === MANIFEST_NAME) {
      try {
        bundle.manifest = JSON.parse(body.toString("utf8"));
      } catch (err) {
        throw new Error(`${path} is not valid JSON: ${err.message}`);
      }
      continue;
    }
    if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
      bundle.images[path] = body.toString("base64");
    } else {
      bundle.files[path] = body.toString("utf8");
    }
  }

  if (Object.keys(bundle.images).length === 0) delete bundle.images;
  if (Object.keys(bundle.files).length === 0) delete bundle.files;
  return { bundle, fileCount, totalBytes: total };
}

// ── the request ─────────────────────────────────────────────────────────────

// postBundle calls POST /v1/import.
//
// Both flags go in the QUERY STRING even though the JSON form would carry them
// too. The handler lets the query win precisely because it is the copy that
// shows up in an access log, and a push that rewrote an org should be legible
// from the outside without anyone replaying the body.
export async function postBundle({ apiUrl, apiKey, dryRun, prune }, bundle, fetchImpl = fetch) {
  const url = `${apiUrl}/v1/import?dry_run=${dryRun}&prune=${prune}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "sendops-push",
      },
      body: JSON.stringify(bundle),
    });
  } catch (err) {
    // A connection failure names the URL. The commonest cause by far is an
    // api_url pointing at the dashboard rather than the API.
    throw new Error(`could not reach ${url}: ${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ""}`);
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, ok: response.ok, body, text };
}

// describeProblem renders an RFC 7807 error body the way a human reads it.
//
// A 403 from this route names the missing scope in the `scope` extension, which
// is the single most useful thing this script can print: the alternative is a
// bare "Insufficient scope" and eight candidate scopes to guess between.
export function describeProblem(status, body, text) {
  const lines = [];
  if (body && typeof body === "object") {
    const title = body.title || body.code || "Request failed";
    lines.push(`HTTP ${status}: ${title}`);
    if (body.detail) lines.push(body.detail);
    if (body.scope) {
      lines.push(`Missing scope: ${body.scope} — add it to the API key and re-run.`);
    }
    if (Array.isArray(body.errors)) {
      for (const e of body.errors) {
        lines.push(`  ${[e.field, e.message].filter(Boolean).join(": ")}`);
      }
    }
    if (body.request_id) lines.push(`Request id: ${body.request_id}`);
  } else {
    lines.push(`HTTP ${status}: the response was not JSON`);
    const snippet = (text ?? "").trim().slice(0, 500);
    if (snippet) lines.push(snippet);
  }
  return lines.join("\n");
}

// planLimitLine is the one line a plan-cap refusal prints (SND-1593): which
// cap, where the bundle would take it, and the page that lifts it. A synced
// repository that does not fit the plan fails whole, and this is what the red
// check says.
//
// It reads the bundle's `plan_limit` when the response carries one, and falls
// back to the standard 402 fields (limit_type, current + would_add) otherwise,
// so a refusal from any cap the server adds later still prints the same line.
export function planLimitLine(body) {
  if (!body || typeof body !== "object") return undefined;
  const pl = body.plan_limit ?? body.plan?.plan_limit;
  let axis, wouldBe, limit, url;
  if (pl && typeof pl === "object") {
    ({ axis, would_be: wouldBe, limit, upgrade_url: url } = pl);
  } else if (body.code === "plan_limit_exceeded" || body.status === 402) {
    axis = body.limit_type;
    limit = body.limit;
    wouldBe = typeof body.current === "number" ? body.current + (body.would_add ?? 1) : undefined;
  } else {
    return undefined;
  }
  url = url || body.upgrade_url;
  const numbers = wouldBe !== undefined && limit !== undefined ? ` ${wouldBe}/${limit}` : "";
  return `Import refused: plan limit — ${axis ?? "unknown"}${numbers}.${url ? ` Upgrade: ${url}` : ""}`;
}

// ── the summary ─────────────────────────────────────────────────────────────

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function diagnosticLine(d) {
  const where = d.path ? (d.line ? `${d.path}:${d.line}:${d.column ?? 0}` : d.path) : "";
  return where ? `${where}: ${d.message}` : d.message;
}

// summarize renders the whole outcome as Markdown, and decides the exit code.
//
// One function for both because the two must agree: every reason the step fails
// has a line in the summary saying so. A red check with a green-looking table is
// how a pipeline teaches people to stop reading it.
export function summarize(result, config, stats) {
  const plan = result?.plan ?? {};
  const objects = (result?.objects?.length ? result.objects : plan.objects) ?? [];
  const dryRun = result?.dry_run ?? config.dryRun;

  const counts = {};
  for (const o of objects) counts[o.action] = (counts[o.action] ?? 0) + 1;
  const changes = objects.filter((o) => CHANGE_ACTIONS.has(o.action)).length;

  const failures = [];
  const refused = planLimitLine(plan.plan_limit ? plan : undefined);
  if (refused) {
    failures.push(refused);
  } else if (plan.applicable === false) {
    failures.push("The bundle is not applicable — nothing was written. Fix the diagnostics below and push again.");
  }
  const failedDeploys = objects.filter((o) => o.deploy_state === "failed");
  for (const o of failedDeploys) {
    failures.push(`Template ${o.key} failed to deploy to SES${o.error ? `: ${o.error}` : "."}`);
  }
  for (const o of objects.filter((o) => o.error)) {
    if (!failedDeploys.includes(o)) failures.push(`${o.kind} ${o.key}: ${o.error}`);
  }
  if (!dryRun && plan.applicable !== false && result?.applied === false) {
    failures.push(
      `The import stopped before finishing${result.applied_until ? ` after ${result.applied_until}` : ""}${result.error ? `: ${result.error}` : "."}`,
    );
  }

  const out = [];
  out.push(`## SendOps push — ${dryRun ? "dry run" : "apply"}`);
  out.push("");
  out.push(
    `\`${config.dir}\` (${stats.fileCount} files) to \`${config.apiUrl}\`${config.prune ? " with prune" : ""}`,
  );
  out.push("");

  if (objects.length === 0) {
    out.push("The bundle declares nothing. Nothing to do.");
  } else if (changes === 0 && failures.length === 0) {
    out.push("**0 changes.** Every object in the bundle matches what SendOps already has.");
  } else {
    const showDeploy = objects.some((o) => o.deploy_state);
    const showMembers = objects.some((o) => o.member_count !== undefined && o.member_count !== null);
    const header = ["Kind", "Key", "Action"];
    if (showDeploy) header.push("Deploy");
    if (showMembers) header.push("Members");
    header.push("Notes");

    out.push(`| ${header.join(" | ")} |`);
    out.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const o of objects) {
      const notes = [];
      for (const d of o.diagnostics ?? []) notes.push(diagnosticLine(d));
      if (o.reason) notes.push(o.reason);
      if (o.referenced_by?.length) notes.push(`referenced by ${o.referenced_by.join(", ")}`);
      if (o.error) notes.push(o.error);

      const row = [o.kind, o.key, o.action];
      if (showDeploy) row.push(o.deploy_state ?? "");
      if (showMembers) row.push(o.member_count ?? "");
      row.push(notes.join("; "));
      out.push(`| ${row.map(escapeCell).join(" | ")} |`);
    }
    out.push("");

    const tally = Object.keys(counts)
      .sort()
      .map((a) => `${a} ${counts[a]}`)
      .join(", ");
    out.push(`**${changes} ${changes === 1 ? "change" : "changes"}** (${tally})`);
  }

  const bundleDiagnostics = plan.diagnostics ?? [];
  if (bundleDiagnostics.length) {
    out.push("");
    out.push("### Bundle diagnostics");
    out.push("");
    for (const d of bundleDiagnostics) out.push(`- ${diagnosticLine(d)}`);
  }

  if (failures.length) {
    out.push("");
    out.push("### Failed");
    out.push("");
    for (const f of failures) out.push(`- ${f}`);
  } else if (dryRun && changes > 0) {
    out.push("");
    out.push("This was a dry run. Nothing was written.");
  }

  return { markdown: out.join("\n") + "\n", changes, applicable: plan.applicable !== false, failures };
}

// ── GitHub plumbing ─────────────────────────────────────────────────────────

// writeGitHubFile appends to one of the runner's `$GITHUB_*` files, and never
// fails the run when it cannot. Outside Actions these are unset, and a missing
// summary file is not a reason to refuse a deploy that otherwise worked.
function writeGitHubFile(envPath, content) {
  if (!envPath) return;
  try {
    appendFileSync(envPath, content);
  } catch (err) {
    console.error(`warning: could not write ${envPath}: ${err.message}`);
  }
}

function setOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeGitHubFile(env.GITHUB_OUTPUT, lines + "\n");
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function run(argv, env, fetchImpl = fetch) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`sendops push: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let config;
  let read;
  try {
    config = resolveConfig(args, env);
    read = readBundle(config.dir);
  } catch (err) {
    console.error(`sendops push: ${err.message}`);
    return 1;
  }

  // A short digest of the body, logged so two runs can be compared without
  // anybody re-uploading anything. It is not sent, and nothing depends on it.
  const payload = JSON.stringify(read.bundle);
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  console.log(
    `sendops push: ${read.fileCount} files (${read.totalBytes} bytes, sha256:${digest}) from ${config.dir} to ${config.apiUrl} [${config.dryRun ? "dry run" : "apply"}${config.prune ? ", prune" : ""}]`,
  );

  let response;
  try {
    response = await postBundle(config, read.bundle, fetchImpl);
  } catch (err) {
    console.error(`sendops push: ${err.message}`);
    return 1;
  }

  if (!response.ok) {
    let detail = describeProblem(response.status, response.body, response.text);
    // A plan cap refusal leads with the one line that says what to do.
    if (response.status === 402) {
      const line = planLimitLine(response.body);
      if (line) detail = `${line}\n${detail}`;
    }
    console.error(detail);
    writeGitHubFile(
      env.GITHUB_STEP_SUMMARY,
      `## SendOps push — failed\n\n\`\`\`\n${detail}\n\`\`\`\n`,
    );
    return 1;
  }
  // A 200 that is not an import result is a failure, not an empty plan. The
  // realistic source is a proxy or an SSO portal answering 200 with a page of
  // its own, and reporting that as "nothing to do" would be the one wrong
  // answer: the pipeline would go green having deployed nothing.
  if (
    response.body === null ||
    typeof response.body !== "object" ||
    Array.isArray(response.body) ||
    typeof response.body.plan !== "object" ||
    response.body.plan === null
  ) {
    const detail = describeProblem(response.status, undefined, response.text);
    console.error(`sendops push: ${detail}`);
    writeGitHubFile(env.GITHUB_STEP_SUMMARY, `## SendOps push — failed\n\n\`\`\`\n${detail}\n\`\`\`\n`);
    return 1;
  }

  const summary = summarize(response.body, config, read);
  // stdout always, the job summary when there is one. A developer running this
  // locally and a reviewer reading a PR check are looking at the same text.
  console.log(summary.markdown);
  writeGitHubFile(env.GITHUB_STEP_SUMMARY, summary.markdown);
  setOutputs(env, { changes: summary.changes, applicable: String(summary.applicable) });

  return summary.failures.length ? 1 : 0;
}

// `node push.mjs` runs; `import ... from "./push.mjs"` does not. The tests
// exercise both the exported helpers and the whole script as a subprocess.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`sendops push: ${err?.stack ?? err}`);
      process.exitCode = 1;
    },
  );
}

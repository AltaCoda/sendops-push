# `sendops push`

Push rendered email templates and audience definitions to [SendOps](https://sendops.dev) from CI.

Keep your repository, your build, and your review process. Render your templates
however you already do — React Email, MJML, plain Handlebars, a script somebody
wrote in 2021 — and let the last step be this one instead of a commit that waits
for a webhook. SendOps never learns the repository exists.

```yaml
- uses: AltaCoda/sendops-push@v1
  with:
    dir: ./sendops
    api_key: ${{ secrets.SENDOPS_API_KEY }}
```

The Action posts the directory to `POST /v1/import`, prints the plan or the
applied result as a job summary, and fails the step if the bundle does not
apply. Running it on an unchanged tree writes nothing and says **0 changes**, so
it is safe on every commit.

---

## What it pushes

A **bundle** is a directory with `sendops.json` at its root plus every file that
manifest names. It is the same format the git sync read, so if you already have a
`/sendops` folder you already have a bundle:

```
sendops/
  sendops.json
  templates/welcome.html
  templates/receipt.html
  audience/all-contacts.sendql
  audience/lists.json
  audience/attributes.json
  audience/activity-properties.json
  audience/topics.json
  audience/workflows/onboarding.flow
  static/logo.png
```

Eight kinds of object can travel in one: templates, segments, lists, topics,
attributes, activity properties, workflows and images. You only need the ones you
use — a templates-only bundle is a perfectly good bundle, and it will never touch
your audience. Images are declared in the manifest as a list of paths,
`"images": ["static/logo.png"]`, and referenced from templates by that path.

The shape of `sendops.json` and of each JSON schema file (attributes, activity
properties, lists and topics) is in
[The bundle format](https://developers.sendops.dev/api-reference/push-from-ci#the-bundle-format).

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `dir` | `./sendops` | The bundle directory. Must contain `sendops.json` at its root. |
| `api_key` | — | **Required.** A SendOps API key. Pass it from a secret. |
| `api_url` | `https://api.sendops.dev` | The API base URL. |
| `dry_run` | `"false"` | Plan only, writing nothing. Set it to `true` on pull requests. |
| `prune` | `"false"` | Archive or delete objects your organization has and the bundle omits. |

| Output | What it is |
| --- | --- |
| `changes` | Objects created, updated, archived or deleted. `0` on an unchanged tree. |
| `applicable` | `"true"` when the bundle passed validation, `"false"` when it did not. |

## Required scopes

The API key needs the `.manage` scope of **each kind your bundle contains**, and
nothing more. A key that can deploy templates and nothing else is the point of
this list, not a limitation of it. If a scope is short, the response is a `403`
that names the missing one and this Action prints it.

| If your bundle contains… | The key needs |
| --- | --- |
| templates (`templates` in the manifest) | `api.templates.manage` |
| segments (`segments`) | `api.segments.manage` |
| lists (`lists`) | `api.lists.manage` |
| topics (`topics`) | `api.topics.manage` |
| attributes (`attributes`) | `api.attributes.manage` |
| activity properties (`activity-properties`) | `api.activities.manage` |
| workflows (`workflows`) | `api.workflows.manage` |
| images (`images`) | `api.assets.manage` |

Create the key in the dashboard under **Workspace → API Keys**.

## The two-mode recipe: plan on the pull request, apply on merge

This is the pattern the Action is designed around. A reviewer sees exactly what
the merge will do, in the PR's own checks, before anyone can apply it.

```yaml
name: SendOps

on:
  pull_request:
    paths: ["emails/**"]
  push:
    branches: [main]
    paths: ["emails/**"]

concurrency:
  group: sendops-${{ github.ref }}
  cancel-in-progress: false

jobs:
  sendops:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Your build. Whatever writes the bundle directory.
      - run: npm ci
      - run: npm run export:sendops

      - uses: AltaCoda/sendops-push@v1
        with:
          dir: ./sendops
          api_key: ${{ secrets.SENDOPS_API_KEY }}
          # Plan on a PR, apply on main. Nothing else differs.
          dry_run: ${{ github.event_name == 'pull_request' }}
```

On a pull request the step prints the plan — every object, its action, and any
diagnostic positioned by line and column — and fails if the bundle would not
apply. On merge the same step applies it.

`concurrency` matters: two pushes racing each other into the same organization
is the one way to get a result nobody asked for. `cancel-in-progress: false`
because a half-cancelled apply is worse than a queued one.

### Pruning

`prune: true` archives segments, lists, topics and workflows your organization
has and the bundle omits, and deletes attributes and activity properties that
nothing still references. It applies only to the sections the bundle actually
declares, so a templates-only push never archives an audience, and an attribute a
remaining segment still uses is reported as `skip` with what blocked it, never
deleted.

Turn it on when the repository is genuinely the whole story. Leave it off while
anyone still authors in the dashboard.

## Writing the exporter

If you render with [React Email](https://react.email), the pattern is: build to
HTML, copy each rendered file into the bundle, and write `sendops.json` last
naming what you copied. The essentials, generalised from the exporter SendOps
runs on itself:

```js
// export-sendops.mjs — run after your build, before sendops push.
import { mkdirSync, rmSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "./out";        // your renderer's HTML output
const BUNDLE = "./sendops"; // what you point sendops push at

const templatesDir = join(BUNDLE, "templates");
// Wipe before writing so a template you deleted stops being pushed.
rmSync(templatesDir, { recursive: true, force: true });
mkdirSync(templatesDir, { recursive: true });

// subjects.json: { "welcome": "Welcome to Example" }
const subjects = JSON.parse(readFileSync("./subjects.json", "utf8"));

const manifest = { templates: {} };
for (const file of readdirSync(OUT).sort()) {
  if (!file.endsWith(".html")) continue;
  const name = file.replace(/\.html$/, "");
  copyFileSync(join(OUT, file), join(templatesDir, file));
  manifest.templates[name] = { path: `templates/${file}`, subject: subjects[name] };
}

// Fail the build here, not in the pipeline: a template with no subject sends
// with its NAME as the subject line, and the recipient sees it.
for (const [name, entry] of Object.entries(manifest.templates)) {
  if (!entry.subject) throw new Error(`template ${name} has no subject`);
}

writeFileSync(join(BUNDLE, "sendops.json"), JSON.stringify(manifest, null, 2) + "\n");
```

Three things worth copying:

- **Sort the keys and wipe the directory.** Deterministic output means a diff of
  the bundle is a diff of what changed, and a deleted template actually
  disappears.
- **Validate in the exporter.** The import validates too, but a failure in your
  own build points at your own source. The import's diagnostics point at the
  rendered HTML.
- **Write the manifest last.** It is the file that makes the directory a bundle;
  writing it first means a crashed build leaves a bundle that claims files it
  does not have.

## Running it outside GitHub Actions

The same script is a CLI. It has no dependencies, so there is nothing to install.

```bash
npx @sendops/push --dir ./sendops --api-key "$SENDOPS_API_KEY" --dry-run
```

| Flag | Environment variable |
| --- | --- |
| `--dir` | `SENDOPS_DIR` |
| `--api-key` | `SENDOPS_API_KEY` |
| `--api-url` | `SENDOPS_API_URL` |
| `--dry-run` | `SENDOPS_DRY_RUN` |
| `--prune` | `SENDOPS_PRUNE` |

Flags win over environment variables. Note that the CLI, like the Action,
defaults `--dry-run` to **false**; the API's own default is true, so a bare
`curl` at `/v1/import` plans rather than applies.

## The wire format

The script reads the directory and POSTs one JSON document:

```json
{
  "manifest": { "templates": { "welcome": { "path": "templates/welcome.html" } } },
  "files":    { "templates/welcome.html": "<!doctype html>…" },
  "images":   { "static/logo.png": "iVBORw0KGgo…" }
}
```

`manifest` is the parsed `sendops.json`. `files` holds text content verbatim;
`images` holds binary content base64-encoded. The split is by encoding, not by
kind — it exists so a pushed bundle stays readable in a request log for the parts
that are text. The endpoint also accepts a zip of the same directory; this script
sends JSON because building a zip would be the only thing it needed a dependency
for.

Full reference: [Push from CI](https://developers.sendops.dev/api-reference/push-from-ci).
If you want the shape of the whole workflow rather than the endpoint, [Keeping a copy in git](https://help.sendops.dev/templates/keeping-a-copy-in-git)
walks through it.

## Image checks

On an apply, each template's result carries the image checks SendOps ran on
it after the bundle's images were uploaded. They show in the summary's **Notes**
column, and inside GitHub Actions also as annotations on the run:

- `::warning title=Image check::` — recipients will likely see a broken or
  blank image: an `{{asset "…"}}` path or relative `src` your asset library does
  not hold, or an SVG asset (Gmail and most Outlook versions do not show SVG).
- `::notice title=Image check::` — an image hot-linked from another site.
  Nothing is wrong with it; you can bring it into your library with
  `POST /v1/assets/import` and use the `{{asset}}` reference it returns.

They never fail the step, and they appear on unchanged templates too, so a
missing image keeps being reported until it is fixed. Nothing is fetched to
produce them, and your source is never rewritten. A dry run does not carry
them; it reports the plan only.

## Exit codes

`0` when the push applied, or the dry run is applicable. `1` for everything
else — and the summary always says which:

- the bundle is not applicable (a validation failure anywhere means **nothing**
  is written, including the objects that passed);
- a template failed to deploy to SES;
- the apply stopped part-way (the summary names the last kind that completed);
- the bundle would take the workspace past a plan limit (segments or
  templates). The import fails whole — nothing is written — and the step prints
  `Import refused: plan limit — <axis> <would_be>/<limit>. Upgrade: <url>`. A
  dry run reports the same line, so a pull request shows it before merge;
- an HTTP error, including a `403` naming the scope the key is missing;
- a response that is not JSON.

## Development

```bash
node --test test/*.test.mjs
```

The source of truth for this repository is the
[sesmail](https://github.com/AltaCoda/sesmail) monorepo at `sendops-push/`; this
repository is a published mirror. Open issues and pull requests against the
monorepo.

## License

Apache 2.0. See [LICENSE](LICENSE).

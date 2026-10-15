# Releasing

archstrict stays on 0.x versions for now. A release has three parts: the npm package, a git tag
with its GitHub release, and the skill and plugin.

A push to `main` that changes `package.json` runs `.github/workflows/publish.yml`. Its `check` job
reads the `package.json` version and looks for the tag `v<version>`. When that tag already exists,
the run releases nothing, so a dependency bump or any other edit to `package.json` is safe. When
the tag does not exist, the `publish` job checks out the pushed commit, runs the release checks,
and runs `npm publish`. npm authenticates with GitHub Actions OIDC through the Trusted Publisher.
The repository stores no `NPM_TOKEN`, and the workflow uses no long-lived npm secret. The GitHub
Environment `publish` is the human gate. Required reviewers approve the job before it can publish.
After `npm publish` succeeds, the `release` job creates the tag and the GitHub release on the
published commit. Nobody pushes a `v*` tag by hand.

Every `uses:` value in a workflow must use a full 40-hex commit SHA. Add the action version in a
trailing comment, for example `uses: actions/checkout@<40-hex> # vX.Y.Z`. A tag ref does not meet
this requirement.

## Trusted publisher

Create the npm Trusted Publisher with these case-sensitive fields:

- Organization or user: `meganemura`
- Repository: `archstrict`
- Workflow filename: `publish.yml`
- Environment name: `publish`
- Allowed action: `npm publish`

Create the GitHub Environment `publish` and add the required reviewers. A private repository
cannot hold an environment with required reviewers, so this step waits until the repository
becomes public. The environment's deployment branch and tag rules must allow deployments from
`main`; a rule that allows only `v*` tags blocks every run, because the workflow now starts from a
push to `main`. The owner sets this rule. The deployment approval appears after a version bump
lands on `main` and the job enters that environment.

The `repository.url` field in `package.json` points at this GitHub repository. npm checks that URL
against the workflow repository. After the first successful publish, require two-factor
authentication for the package and disallow token publishing. The Trusted Publisher will continue
to work.

## Each version

A release that changes the Config type gets a rerun-init line in its changelog entry.

1. In one commit, turn the `## Unreleased` section of `CHANGELOG.md` into a `## 0.x.y (date)`
   section, and start a new empty `## Unreleased` above it if you want one. The release job's awk
   matches `## 0.x.y ` followed by a space, so keep the `(date)` after the version. Set the same
   version in `package.json`, `package-lock.json`, and `.agents/plugin.json`.
2. Run `npm run build`, `npm run typecheck`, and `npm test`.
3. Run `npm pack --dry-run`. Read its file list. It must contain `dist/`, `docs/`, `skills/`, both
   READMEs, the changelog, `AGENTS.md`, `llms.txt`, `.agents/`, and the license. It must not contain
   `test/`, `.claude-team/`, or `.agents/skills/`.
4. Commit the release as `chore: release 0.x.y` and land it on `main` through the `queue` branch.
   Do not push a tag. The push to `main` that changes `package.json` starts the workflow.
5. Approve the `publish` environment for that Actions run. The workflow runs `npm ci`, the build,
   typecheck, and tests before `npm publish`. `prepublishOnly` repeats those checks.
6. After `npm publish` succeeds, the workflow's `release` job creates the tag `v0.x.y` on the
   published commit and the GitHub release. It extracts only that version's section from
   `CHANGELOG.md` (the whole file would carry every version), and it skips a release that already
   exists, so re-running the job is safe. If that job fails, re-run it from the Actions page.
7. Install or update the skill and plugin for the agents that use this repository, following
   whatever install path Claude Code and the agent's own tooling document for a plugin repository
   at that time; this repository names no fixed install command for that step.

The owner approves the `publish` environment. The workflow then publishes to npm and creates the
tag and the GitHub release.

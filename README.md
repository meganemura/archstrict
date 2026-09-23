# archstrict

arch is architecture, not tsc, not eslint, not a type checker: module boundary checking.
Not archetype.

TypeScript module boundary checking, in the sense of ArchUnit (Java) and archspec (Ruby): a module is one directory declared explicitly in config, it shows the rest of the codebase one public-surface file, and everything else inside it is private.

See [AGENTS.md](AGENTS.md) for the shape, the rules, and the commands, and [skills/archstrict/SKILL.md](skills/archstrict/SKILL.md) for the workflow.

## Install

Not published to npm yet - install from a local checkout of this repository.

```sh
# in this checkout
npm run build   # if dist/ is missing or stale
npm link

# in the project you want to check
npm link archstrict
```

This puts a real `archstrict` binary at `node_modules/.bin/archstrict` in that project - the exact path the PostToolUse hook (see [hook.md](skills/archstrict/references/hook.md)) checks for before running `check` on your behalf after an edit. `npm unlink archstrict` in the target project removes it again.

Without a global link: `npm pack` in this checkout produces a tarball (`archstrict-0.0.0.tgz`), then `npm install /path/to/that/tarball` in the target project does the same thing. The tarball includes the agent skill (`skills/archstrict/SKILL.md` and `skills/archstrict/references/`) and `llms.txt`. After install those paths sit under `node_modules/archstrict/`, the same layout as this repository, so an agent can read the workflow without a git checkout.

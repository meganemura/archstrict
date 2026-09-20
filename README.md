# archstrict

arch is architecture, not tsc, not eslint, not a type checker: module boundary checking.
Not archetype.

TypeScript module boundary checking, in the sense of ArchUnit (Java) and archspec (Ruby): a module is one directory declared explicitly in config, it shows the rest of the codebase one public-surface file, and everything else inside it is private.

See [AGENTS.md](AGENTS.md) for the shape, the rules, and the commands, and [skills/archstrict/SKILL.md](skills/archstrict/SKILL.md) for the workflow.

import type { Config } from "../../../src/config.js";

export default {
  configPath: "<generated>",
  because: "converted from architecture.config.json",
  scope: "packages/**",
  classify: [
  {
    "glob": "packages/1-framework/0-foundation/**",
    "tags": [
      "domain:framework",
      "layer:foundation",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/config/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/operations/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/shared/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/control/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/execution/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/authoring.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/codec.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/components.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/control.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/emission.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/execution.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/psl-ast.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/src/exports/runtime.ts",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/framework-components/test/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/1-core/errors/**",
    "tags": [
      "domain:framework",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/1-framework/2-authoring/**",
    "tags": [
      "domain:framework",
      "layer:authoring",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/2-authoring/ids/**",
    "tags": [
      "domain:framework",
      "layer:authoring",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/cli/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/config-loader/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/emitter/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/language-server/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/eslint-plugin/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/migration/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/vite-plugin-contract-emit/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/1-framework/3-tooling/cli-telemetry/**",
    "tags": [
      "domain:framework",
      "layer:tooling",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-sql/1-core/**",
    "tags": [
      "domain:sql",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-sql/1-core/errors/**",
    "tags": [
      "domain:sql",
      "layer:core",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-sql/2-authoring/**",
    "tags": [
      "domain:sql",
      "layer:authoring",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/2-sql/3-tooling/emitter/**",
    "tags": [
      "domain:sql",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/2-sql/9-family/src/core/**",
    "tags": [
      "domain:sql",
      "layer:family",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-sql/9-family/src/exports/control.ts",
    "tags": [
      "domain:sql",
      "layer:family",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/2-sql/9-family/src/exports/runtime.ts",
    "tags": [
      "domain:sql",
      "layer:family",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/2-sql/9-family/src/exports/pack.ts",
    "tags": [
      "domain:sql",
      "layer:family",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-sql/4-lanes/**",
    "tags": [
      "domain:sql",
      "layer:lanes",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/2-sql/5-runtime/**",
    "tags": [
      "domain:sql",
      "layer:runtime",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/middleware-cache/**",
    "tags": [
      "domain:extensions",
      "layer:integrations",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/sql-orm-client/**",
    "tags": [
      "domain:extensions",
      "layer:integrations",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/postgres/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/postgres/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/postgres/src/core/**",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/postgres/src/exports/control.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/postgres/src/exports/runtime.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/postgres-codec-testkit/src/**",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/7-drivers/postgres/src/exports/control.ts",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/7-drivers/postgres/src/exports/runtime.ts",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/config/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/config.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/runtime/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/contract-builder.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/migration.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/family.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/postgres/src/exports/target.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/config/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/config.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/runtime/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/config/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/exports/config.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/contract/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/exports/contract-builder.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/exports/migration.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/bson.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/contract-builder.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/contract/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/family.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/mongo/src/exports/target.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/sqlite/src/core/**",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/sqlite/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/sqlite/src/exports/pack.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/3-targets/sqlite/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/core/**",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/adapter.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/codec-types.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/column-types.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/control.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/runtime.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite/src/exports/types.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/6-adapters/sqlite-codec-testkit/src/**",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/7-drivers/sqlite/src/core/**",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-targets/7-drivers/sqlite/src/exports/control.ts",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-targets/7-drivers/sqlite/src/exports/runtime.ts",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/runtime/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/sqlite/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/paradedb/src/core/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/paradedb/src/types/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/paradedb/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/paradedb/src/exports/index-types.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/paradedb/src/exports/pack.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/core/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/types/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/exports/control.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/exports/codec-types.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/pgvector/src/exports/operation-types.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/pack/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/exports/pack.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/runtime/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/contract/**",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-extensions/supabase/src/exports/contract.ts",
    "tags": [
      "domain:extensions",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/1-foundation/**",
    "tags": [
      "domain:mongo",
      "layer:foundation",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/2-authoring/**",
    "tags": [
      "domain:mongo",
      "layer:authoring",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/3-tooling/emitter/**",
    "tags": [
      "domain:mongo",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/2-mongo-family/3-tooling/mongo-schema-ir/**",
    "tags": [
      "domain:mongo",
      "layer:tooling",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/2-mongo-family/4-query/**",
    "tags": [
      "domain:mongo",
      "layer:query",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/5-query-builders/orm/**",
    "tags": [
      "domain:mongo",
      "layer:query-builders",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/2-mongo-family/5-query-builders/pipeline-builder/**",
    "tags": [
      "domain:mongo",
      "layer:query-builders",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/2-mongo-family/6-transport/**",
    "tags": [
      "domain:mongo",
      "layer:transport",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/7-runtime/**",
    "tags": [
      "domain:mongo",
      "layer:runtime",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/2-mongo-family/9-family/src/core/**",
    "tags": [
      "domain:mongo",
      "layer:family",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/2-mongo-family/9-family/src/exports/control.ts",
    "tags": [
      "domain:mongo",
      "layer:family",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-mongo-target/1-mongo-target/src/exports/pack.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-mongo-target/1-mongo-target/src/exports/runtime.ts",
    "tags": [
      "domain:extensions",
      "layer:targets",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-mongo-target/2-mongo-adapter/src/core/**",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-mongo-target/2-mongo-adapter/src/exports/control.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:migration"
    ]
  },
  {
    "glob": "packages/3-mongo-target/2-mongo-adapter/src/exports/index.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-mongo-target/2-mongo-adapter/src/exports/runtime.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:runtime"
    ]
  },
  {
    "glob": "packages/3-mongo-target/2-mongo-adapter/src/exports/codec-types.ts",
    "tags": [
      "domain:targets",
      "layer:adapters",
      "plane:shared"
    ]
  },
  {
    "glob": "packages/3-mongo-target/3-mongo-driver/**",
    "tags": [
      "domain:targets",
      "layer:drivers",
      "plane:runtime"
    ]
  }
],
  edges: {
  "allowDeny": [
    {
      "source": "domain:framework",
      "targetNamespace": "domain",
      "allow": [],
      "because": "Framework domain is the innermost/core domain and may not import from any other domain"
    },
    {
      "source": "domain:sql",
      "targetNamespace": "domain",
      "allow": [
        "framework"
      ],
      "because": "SQL domain may import only from framework domain"
    },
    {
      "source": "domain:mongo",
      "targetNamespace": "domain",
      "allow": [
        "framework"
      ],
      "because": "Mongo domain may import only from framework domain"
    },
    {
      "source": "domain:targets",
      "targetNamespace": "domain",
      "allow": [
        "framework",
        "sql",
        "mongo"
      ],
      "because": "Targets domain may import from framework, sql, and mongo domains"
    },
    {
      "source": "domain:extensions",
      "targetNamespace": "domain",
      "allow": [
        "framework",
        "sql",
        "mongo",
        "targets",
        "extensions"
      ],
      "because": "Extensions domain may import from any domain"
    },
    {
      "source": "plane:shared",
      "targetNamespace": "plane",
      "deny": [
        "migration",
        "runtime"
      ],
      "exceptions": [],
      "because": "the shared plane must not depend on: migration, runtime"
    },
    {
      "source": "plane:migration",
      "targetNamespace": "plane",
      "deny": [
        "runtime"
      ],
      "exceptions": [],
      "because": "the migration plane must not depend on: runtime"
    },
    {
      "source": "plane:runtime",
      "targetNamespace": "plane",
      "deny": [
        "migration"
      ],
      "exceptions": [],
      "because": "the runtime plane must not depend on: migration"
    }
  ],
  "order": [
    {
      "tagNamespace": "layer",
      "within": "domain",
      "sequence": {
        "framework": [
          "foundation",
          "core",
          "authoring",
          "tooling"
        ],
        "sql": [
          "core",
          "authoring",
          "tooling",
          "lanes",
          "runtime",
          "adapters",
          "drivers",
          "family"
        ],
        "mongo": [
          "foundation",
          "authoring",
          "tooling",
          "query",
          "query-builders",
          "transport",
          "runtime",
          "family"
        ]
      },
      "direction": "downward-only",
      "because": "dependencies flow toward core; lateral within a layer is allowed"
    }
  ]
},
} satisfies Config;

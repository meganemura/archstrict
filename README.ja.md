# 🧱 archstrict

[English](README.md)

[![npm version](https://img.shields.io/npm/v/archstrict?logo=npm)](https://www.npmjs.com/package/archstrict)

archstrict は TypeScript の module 境界を検査する。ArchUnit(Java)や archspec(Ruby)と同じ考え方に立つ。config で各 module を宣言する。module は 1 個の directory であり、glob が 1 個の file を指すときはその file である。module は codebase の他の部分に対して public-surface file を 1 個だけ見せ、その file が export しないものは private である。

tsc と型チェッカーが見るのは型であり、ESLint が見るのは style である。archstrict が見るのは境界である。その public surface を越えて module の内部へ届く import は violation になる。

## 導入

どの host でも、まずプロジェクトに npm package を入れる。

```sh
npm install -D archstrict
```

Node.js 22 以降が要る。

これで、プロジェクトの `node_modules/.bin/archstrict` に実体の `archstrict` binary が置かれる。編集 hook と CI はこの binary を実行し、MCP server は同じ導入済みの package を読み込む。

### 各部品の役割

- **CLI**(`npm install -D archstrict`)は `init`、`check`、`todo` などの verb を実行する。violation を見つけるのはこの部品だけである。
- **skill**(`skills/archstrict/`)は、violation の報告の読み方と config の変え方を agent に教える。host は `node_modules/` からではなく、host 自身の skill directory から読み込む。
- **AGENTS.md の節**(`archstrict agents`)は、`AGENTS.md` を読むすべての agent に、file を作る前や import を足す前に `archstrict rules <path>` を実行し、編集の後に `archstrict check` を実行するよう指示する。数行のプロジェクト向け指示であり、skill ではない。
- **編集 hook**(Claude Code 専用)は編集ごとに動く。PreToolUse hook は変更を事前に確かめ、PostToolUse hook は `archstrict check <file>` を実行して violation を agent の文脈に返す。[hook.md](skills/archstrict/references/hook.md) を参照。
- **MCP server**(Claude Code の plugin)は、`check`、`rules`、`search`、`simulate` を tool として agent に渡す。
- **CI** は、どの host が加えた変更にも `archstrict check` を実行する。

### Claude Code

このリポジトリの marketplace から plugin を入れる。plugin は skill、2 個の編集 hook、MCP server を持つ。Claude Code の中で次を実行する。

```text
/plugin marketplace add meganemura/archstrict
/plugin install archstrict@archstrict
```

hook はプロジェクト自身の `node_modules/.bin/archstrict` を実行するので、上の npm install も要る。`node_modules/archstrict/` は plugin として読み込まれない。npm は plugin root に要る symlink(`.claude-plugin/plugin.json`、`hooks/`、`mcp/`)を含めないためである。plugin の file 自体は `node_modules/archstrict/.agents/` に入っている。リリース前の checkout を試すときは、`claude --plugin-dir <clone のパス>` で 1 回の session だけ読み込む。

### その他の agent(Cursor、Codex、cloud agent)

編集 hook は Claude Code 専用である。それ以外の agent では、次の 3 つを使う。

1. GitHub CLI で、公開リポジトリから skill を入れる。`cursor` は、`gh skill install --help` にある自分の agent の値に置き換える。

   ```sh
   gh skill install meganemura/archstrict archstrict --agent cursor
   ```

   既定の scope はプロジェクトである。Cursor、Codex など複数の agent が `.agents/skills/archstrict/` を共有する。home directory に入れるときは `--scope user` を足す。

2. AGENTS.md の節を足す。

   ```sh
   npx archstrict agents
   ```

3. CI で `archstrict check` を実行する。編集 hook が無いので、agent の session で生じた violation は CI で捕まえる。

   ```yaml
   - run: npm ci
   - run: npx archstrict check
   ```

## クイックスタート

```sh
npm install -D archstrict
npx archstrict init
npx archstrict check
```

`init` は、`archstrict.config.ts` が無いときその file を書く。あわせて、module 名の union type である `archstrict.types.ts` を書く。初回は、TypeScript source(`.ts`、`.tsx`、`.mts`、`.cts`)を持つ top-level directory ごとに 1 module を宣言し、subdirectory には入っていない top-level の source file ごとに 1 module を宣言する。対象は、開いた container の中と project root の両方である。container は、`src/` が source を持つときは `src/`、`src/` が無い、または source を持たないときは project root である。再実行したときは、手で編集した config をそのまま残し、`declaredModules` から `archstrict.types.ts` だけを再生成する。

`check` は project を解析し、各 violation を rule id、`path:line:col`、evidence、`because` の理由、`do:` command とともに表示する。

config は TypeScript の値 1 個である。`init` は歩いた tree から実際の `declaredModules` を書く。下の entry は、directory module と single-file module の例である。下の `exclude` は、`init` が常に書く基本のリストである。`init` は、disk 上で見つけた noise directory と colocated test file の pattern についても、それぞれ entry を足す。

```ts
import type { Config } from "./archstrict.types.js";

export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: ["archstrict.config.ts", "archstrict.types.ts", ".*/**", "**/.*/**"],
  declaredModules: [
    { name: "app", glob: "src/app/**" },
    { name: "shared", glob: "src/shared/**" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
  ],
  because: "app and shared are directory modules; cli.ts is one loose file, public as itself",
} satisfies Config;
```

`surface` は directory module の public-surface file の名前である。single-file module は、上の `cli.ts` のように、その file 自身を `surface` として書く。`because` は必須である。どの `declaredModules` の glob にも、どの `exclude` の pattern にも一致しない file は `uncovered-module` violation になる。

rule、command、config の全体については、[AGENTS.md](AGENTS.md)、[skills/archstrict/SKILL.md](skills/archstrict/SKILL.md)、[skills/archstrict/references/config.md](skills/archstrict/references/config.md) を参照する。

## local checkout からの導入

上の `npm install` は公開済みの package を入れる。この repository の checkout から作業する contributor と agent は、次のいずれかを使う。

1. **同じ machine 上の local checkout からの `npm link`。**

   ```sh
   # この checkout の中で
   npm run build   # dist/ が無いか古い場合
   npm link

   # 検査したいプロジェクトの中で
   npm link archstrict
   ```

   対象プロジェクトで `npm unlink archstrict` を実行すれば取り除ける。

2. **local checkout への `file:` 依存**。依存関係を global link ではなく、対象側の `package.json` 自体に記録したい場合に使う。

   ```json
   "archstrict": "file:../archstrict"
   ```

   `npm install` はこれを `npm link` と同じ symlink に変換し、build 手順は実行しない。対象プロジェクトで `npm install` を実行する前に、checkout 側で `npm run build` を実行する。symlink 化された `file:` 依存は checkout 自身の lifecycle script を実行しないため、`prepare` script は決して build を行わない。build 前に既に install していた場合は、対象プロジェクトで `npm install` をやり直す。これで `dist/` ができた後の binary にリンクし直される。

3. **git 依存**(`"archstrict": "github:<owner>/archstrict#<ref>"`)。この checkout に到達できないが、git 経由で repository を読める machine 向け。`dist/` は commit されていないため、npm は package の devDependencies を install し、clone 後に `prepare` script(`npm run build`)を実行して `dist/` を build する。2 つの条件がある。
   - install する machine が repository を読めること。access がその repository だけの agent はここで 404 になるため、方法 4 を使う。
   - lifecycle script が有効であること。npm config で `ignore-scripts=true` の場合、`prepare` は実行されず `dist/` の無い install になり、`node_modules/.bin/archstrict` は存在しない file を指す。この install だけ `--ignore-scripts=false` を渡すか、方法 4 を使う。

4. **`npm pack` が作る tarball** を対象 machine にコピーする方法。この repository に一切 access できない対象(例えば access がその repository だけの agent)でも動く唯一の方法である。

   ```sh
   # この checkout の中で
   npm run build
   npm pack   # archstrict-<version>.tgz を書き出す

   # tarball を対象 machine にコピーしたあと、対象プロジェクトの中で
   npm install ./archstrict-<version>.tgz
   ```

   `npm pack` は checkout の working tree を packing する。git 履歴ではないため、`dist/` が既に build 済みであることが要る。実際に実行して確認済み: tarball には `dist/`、`skills/`、`llms.txt`、`.agents/`、`README.md`、`README.ja.md`、`CHANGELOG.md`、`docs/`、`AGENTS.md`、`LICENSE`、`package.json` が入る。これは `npm link` と `file:` の方法が見せる集合と同じで、それに packaging 自体が加わる。

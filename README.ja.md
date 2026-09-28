# 🧱 archstrict

[English](README.md)

[![npm version](https://img.shields.io/npm/v/archstrict?logo=npm)](https://www.npmjs.com/package/archstrict)

arch は architecture の略であり、tsc でも eslint でも型チェッカーでもない。module 境界を検査する道具である。
archetype(アーキタイプ)の略ではない。

TypeScript の module 境界検査であり、ArchUnit(Java)や archspec(Ruby)と同じ考え方に立つ。module は config で明示的に宣言した 1 個の directory であり、他の module に対しては 1 個の public-surface file だけを見せる。その file が export しないものはすべて private である。

repository の形、rule、command は [AGENTS.md](AGENTS.md) を、実際の workflow は [skills/archstrict/SKILL.md](skills/archstrict/SKILL.md) を参照する。

## 導入

```sh
npm install --save-dev archstrict
```

これで、プロジェクトの `node_modules/.bin/archstrict` に実体の `archstrict` binary が置かれる。これは PreToolUse と PostToolUse の 2 個の hook([hook.md](skills/archstrict/references/hook.md) を参照)が、編集の前後で変更を確認するために探す path そのものである。この導入では、agent skill(`skills/archstrict/SKILL.md` と `skills/archstrict/references/`)、`llms.txt`、`.agents/`(plugin manifest、2 個の hook、MCP server)も `node_modules/archstrict/` に入る。npm は checkout 側の symlink(`.claude-plugin/plugin.json`、`hooks/`、`mcp/`)を含めないため、導入後の hook は `node_modules/archstrict/.agents/hooks/pre-tool-use.mjs` と `post-tool-use.mjs` になり、MCP server は `node_modules/archstrict/.agents/mcp/server.mjs` になる。git の checkout では、それらの symlink を通じて Claude Code の plugin として読み込まれる。

### local checkout からの導入

この repository の未公開の checkout に対して作業するときは、代わりに次のいずれかを使う。

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

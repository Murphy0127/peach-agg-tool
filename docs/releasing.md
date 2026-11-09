# Release and Codex Skill installation

The CLI and bundled `peach` skill use the same release version. The launcher
pins that version so a newly installed skill cannot accidentally run the old API
implementation. Node.js >=20.18.1 is required by the HTTP dependency.

## Release preparation

1. Update `package.json`, the root package in `package-lock.json`, both Claude
   plugin manifests, and the pinned version in `skills/peach/scripts/run.mjs`.
2. Run `npm test`, `npm run typecheck`, the skill creator's `quick_validate.py`
   against `skills/peach`, and `git diff --check`.
3. Run `npm pack --pack-destination /absolute/release/directory`. `prepack`
   builds the CLI. Inspect the tarball and install it into a fresh prefix;
   verify `--version`, `benchmark --help`, and a quote-only smoke test from a
   different working directory. No private `.env` belongs in the tarball.
4. Commit the reviewed sources and create an annotated `vVERSION` tag. Push
   without force; the default branch must remain a fast-forward. Create a
   GitHub Release for that tag and attach the same `.tgz` that was verified.
5. Download the published asset, verify its checksum, and test the skill
   launcher with an isolated HOME, empty user npm config and fresh cache. This
   verifies the first-run path without a local CLI or npm authentication.

GitHub Releases are the distribution source. Publishing this tool to the npm
registry is not part of the release workflow. npm/npx remain installation
clients and fetch the tarball's public dependencies; no npm login is needed.
Never replace an existing release asset/tag with different bytes. Use a new
patch version for distribution fixes.

## Install CLI 0.6.1

Install the exact artifact from the GitHub Release:

```bash
npm install --global --prefix "$HOME/.local" https://github.com/Murphy0127/peach-agg-tool/releases/download/v0.6.1/peach-agg-tool-0.6.1.tgz
```

The skill launcher searches both PATH and `~/.local/bin`, so shell profile
changes are unnecessary for skill use. For direct terminal use, invoke
`~/.local/bin/peach-agg-tool` or add `~/.local/bin` to your PATH.

If no matching CLI is installed, the skill launcher uses npx to install this
same tagged GitHub asset into the user's npm cache. It never requests
`peach-agg-tool@latest` or a version that must exist on the npm registry.

## Install the Codex skill

Ask Codex:

```text
Use $skill-installer to install the peach skill from
https://github.com/Murphy0127/peach-agg-tool/tree/v0.6.1/skills/peach
```

For local development, Codex also discovers a symlink in `~/.agents/skills`:

```bash
mkdir -p "$HOME/.agents/skills"
ln -s /absolute/path/to/peach-agg-tool/skills/peach "$HOME/.agents/skills/peach"
```

Do not overwrite an existing skill directory. Newly installed skills are
available on the next turn; restart Codex if discovery has not refreshed.
Then ask, for example:

```text
用 $peach 对比 BSC 上 100 USDT 换 WBNB，比较 Peach prod/pre、Kyber、OKX，分析报价差距。
```

This is a standalone filesystem skill, not a listing in the OpenAI public
plugin directory. Existing `.claude-plugin` metadata supports the original
Claude installation path. Official local skill format/discovery:
https://learn.chatgpt.com/docs/build-skills

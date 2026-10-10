# Contributing

Issues and pull requests are welcome. This page covers the dev loop, the rules
for branches and pull requests, and how a release is published. For how the
code is organized, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Dev loop

Use the Node version in [`.nvmrc`](.nvmrc). The package requires Node 20.9 or
later, and `.npmrc` rejects older versions.

```bash
npm ci                 # install exactly what package-lock.json pins
git lfs pull           # sample images for the browser example (Git LFS)

npm run typecheck      # tsc --noEmit over the library
npm run lint           # eslint: src/**/*.ts, src/**/*.html, the example tile server
npm run format         # prettier --write (CI runs npm run format:check)
npm test               # jest (jest-preset-angular)
npm run test:coverage  # jest with coverage; fails below the floor in jest.config.ts
npm run build          # ng-packagr → dist/, then bundle the workers into dist/fesm2022/
```

To try a change in a running app, build the library and start the browser
example. It consumes the built package from `dist/`, so rebuild after changing
`src/`:

```bash
npm run build
npm run start:example  # http://localhost:5173
```

The example tile server has its own dependencies and `node:test` suite:

```bash
cd examples/tile-server && npm ci && npm test
```

CI ([`.github/workflows/ci-cd.yaml`](.github/workflows/ci-cd.yaml)) runs
typecheck, lint, the Prettier check, the tests, the library build, the example build against the
staged package, and the tile-server tests. A pull request needs all of them
green.

## Branches and pull requests

**Every change to `main` goes through a pull request.** Nobody commits or pushes
to `main` directly.

1. Branch from `origin/main` **without tracking it**, so that a plain
   `git push` can never land on `main`:
   ```bash
   git fetch origin
   git switch --no-track -c <branch> origin/main
   # or, for a separate worktree:
   git worktree add --no-track -b <branch> <path> origin/main
   ```
2. Push with an explicit refspec:
   ```bash
   git push -u origin HEAD:<branch>
   ```
3. Open the pull request against `main`:
   ```bash
   gh pr create --base main --head <branch>
   ```

Branch names follow the change: `fix/…`, `feat/…`, `docs/…`, `chore/…`,
`release/x.y.z`.

## Changes

- **Commits** use conventional prefixes scoped to the area:
  `fix(osd): …`, `feat(spatial): …`, `refactor(napari): …`, `docs(readme): …`,
  `chore(deps): …`. Keep them small and explain _why_ in the body.
- **Bug fixes come with a regression spec** that fails before the fix.
- **Behaviour-preserving refactors** stay separate from behaviour changes.
- **Public API:** anything exported from `src/index.ts` is public. Give new
  exports and every `@Input`/`@Output` a JSDoc comment. Members that only a
  template uses should be `protected` so they stay out of the published types.
- **Layering:** `src/lib/contracts/` must not import implementations, stores,
  the toolbar or components. eslint enforces this.
- **Logging:** no `console.log` in library code. `console.warn` and
  `console.error` are for real failures only.
- **napari-js:** jest runs against `src/lib/testing/napari-js-stub.ts`. If you
  use a napari-js API the stub lacks, extend the stub in the same change.
- **CHANGELOG:** add an entry under `## [Unreleased]` in
  [`CHANGELOG.md`](CHANGELOG.md) as part of the change, not at release time.
  Use short [Keep a Changelog](https://keepachangelog.com/) bullets (one or two
  lines each) that link the pull request. Put design rationale in the PR or in
  `docs/design/`.

## Releasing

Publishing is automated by CI. A `v*.*.*` tag builds, tests and runs
`npm publish --access public --provenance` from `dist/`. The tag must match the
`package.json` version, and its commit must be reachable from `main` or a
`release/x.y.z` branch. CI needs an `NPM_TOKEN` repository secret with publish
rights to the `@jax-data-science` npm scope.

1. Branch `release/x.y.z` from `origin/main` (as above). Bump `version` in
   `package.json` and `package-lock.json` (`npm version x.y.z --no-git-tag-version`),
   and move the `[Unreleased]` CHANGELOG entries under `## [x.y.z] — YYYY-MM-DD`.
2. Commit as `chore(release): x.y.z`, push, and open a pull request to `main`.
3. After it merges, tag the merge commit and push the tag:
   ```bash
   git fetch origin
   git tag vx.y.z origin/main
   git push origin vx.y.z
   ```

The GitHub Pages demo
([`.github/workflows/pages.yaml`](.github/workflows/pages.yaml)) redeploys on
every push to `main` that touches `src/` or the example.

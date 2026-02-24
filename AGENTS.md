# AGENTS.md

## npm release

- npm publish is handled by GitHub Actions via `.github/workflows/publish.yml`.
- Releases are triggered by Git tags (`v*`) or by manually running the `Publish` workflow with a `tag` input.
- GitHub labels do **not** trigger npm release in this repo.
- The tag must match `package.json` exactly (for example, `package.json` `3.0.2` requires tag `v3.0.2`).

### Standard release flow

1. Bump version in `package.json` and `package-lock.json`.
2. Commit and push to `main`.
3. Create and push tag `vX.Y.Z`.
4. GitHub Actions `Publish` workflow performs `npm publish`.

# Skills Pack

A reviewed collection of portable agent skills maintained by `aganano-joshua`.

## Install the 20 vendored skills

```bash
npx skills@latest add aganano-joshua/skills-pack --all
```

## Install all 23 pinned skills

Clone this repository, then run:

```bash
npm ci
npm run install-skills -- --target /path/to/your/project
```

The complete installer includes three skills that remain at their original upstream repositories because this pack does not redistribute them. Their exact revisions and hashes are recorded in `sources.json`.

Use `--agent <name>` to target one supported agent. The default is `*`. Use `--force` only when you intend to replace a different installed skill. Context files are not copied into target projects unless you add `--context`.

## Review upstream changes

The weekly GitHub Actions workflow prepares one pull request with source revisions, hashes, license evidence, validation results, and skill content changes. It never merges the pull request.

Run the same checks locally:

```bash
npm run update-skills
npm run validate
npm test
```

## Licensing

Each vendored skill remains governed by its upstream license. Preserved license and notice files live under `licenses/`. See `sources.json` and `THIRD_PARTY_NOTICES.md` for provenance.

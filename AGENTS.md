# Skills pack agent guide

## Purpose

This repository publishes reviewed agent skills with traceable upstream sources. Treat every skill update as executable instruction changes that require human review.

## Repository layout

* `skills/` contains only skills whose upstream licenses permit redistribution.
* `sources.json` is the source of truth for upstream revisions, content hashes, licenses, and distribution mode.
* `licenses/` preserves license and notice material for redistributed skills.
* `scripts/` contains installation, update, and validation tools.

## Commands

* Run `npm ci` before using repository scripts.
* Run `npm run validate` to check the manifest, snapshots, notices, and context files.
* Run `npm test` for automated behavior checks.
* Run `npm run install-skills -- --target <path>` to install all pinned skills.
* Run `npm run update-skills` to prepare reviewed upstream changes locally.

## Trust and updates

Never merge upstream instruction changes without reading the skill diff. The weekly workflow may create or update a pull request, but it must never merge one. Do not execute scripts from upstream repositories during import or update.

## Contributions

Keep snapshot files identical to their pinned upstream skill directories. Record every source with a full commit SHA and SHA 256 content hash. Preserve applicable copyright, license, and notice files. A source without a clear redistribution license must remain in `direct` mode and must not appear under `skills/`.

Do not commit credentials, personal data, local home directory paths, generated dependencies, or temporary checkouts.

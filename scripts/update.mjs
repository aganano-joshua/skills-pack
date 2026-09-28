import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync, treeHash, validateSkillDirectory } from "./lib.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArguments(argv) {
  const reportIndex = argv.indexOf("--report");
  return { report: reportIndex >= 0 ? argv[reportIndex + 1] : join(repositoryRoot, "update-report.md") };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function repositoryKey(url) {
  return new URL(url).pathname.replace(/^\//, "").replace(/\.git$/, "").replaceAll("/", "__");
}

async function cloneLatest(repository, destination) {
  await execFileAsync("git", ["clone", "--quiet", "--depth", "1", repository, destination]);
  return (await execFileAsync("git", ["-C", destination, "rev-parse", "HEAD"])).stdout.trim();
}

function licenseLooksValid(spdx, bodies) {
  if (spdx === "NONE-DETECTED") return true;
  const content = bodies.join("\n");
  if (spdx === "MIT") return /MIT License/i.test(content);
  if (spdx === "Apache-2.0") return /Apache License|license:\s*Apache-2\.0/i.test(content);
  return content.length > 0;
}

async function updateLicenseFiles(skill, checkout) {
  const evidenceBodies = [];
  for (const evidence of skill.license.evidence) {
    if (evidence.startsWith("No ")) continue;
    const source = join(checkout, evidence);
    if (!(await exists(source))) throw new Error(`${skill.name} license evidence disappeared: ${evidence}`);
    evidenceBodies.push(await readFile(source, "utf8"));
  }
  if (!licenseLooksValid(skill.license.spdx, evidenceBodies)) {
    throw new Error(`${skill.name} license evidence no longer matches ${skill.license.spdx}`);
  }

  let changed = false;
  for (const notice of skill.license.notices) {
    const sourceName = basename(notice);
    const evidence = skill.license.evidence.find((entry) => basename(entry) === sourceName);
    if (!evidence) throw new Error(`${skill.name} has no upstream evidence mapped to ${notice}`);
    const source = join(checkout, evidence);
    const destination = join(repositoryRoot, notice);
    const incoming = await readFile(source);
    const current = (await exists(destination)) ? await readFile(destination) : null;
    if (!current || incoming.compare(current) !== 0) {
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
      changed = true;
    }
  }
  return changed;
}

export async function updateSkills({ report }) {
  const manifestPath = join(repositoryRoot, "sources.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const workspace = await mkdtemp(join(tmpdir(), "skills-pack-update-"));
  const repositories = new Map();
  const changes = [];

  try {
    for (const repository of [...new Set(manifest.skills.map((skill) => skill.repository))]) {
      const checkout = join(workspace, repositoryKey(repository));
      const revision = await cloneLatest(repository, checkout);
      repositories.set(repository, { checkout, revision });
    }

    for (const skill of manifest.skills) {
      const { checkout, revision } = repositories.get(skill.repository);
      const source = join(checkout, skill.path);
      await validateSkillDirectory(source, skill.name);
      const incomingHash = await treeHash(source);
      const oldRevision = skill.revision;
      const oldHash = skill.contentHash;
      let licenseChanged = false;

      if (skill.distribution === "snapshot") {
        licenseChanged = await updateLicenseFiles(skill, checkout);
        if (incomingHash !== oldHash) {
          const destination = join(repositoryRoot, "skills", skill.name);
          await rm(destination, { recursive: true, force: true });
          await cp(source, destination, { recursive: true });
        }
      } else {
        await updateLicenseFiles(skill, checkout);
      }

      if (incomingHash !== oldHash || licenseChanged) {
        skill.revision = revision;
        skill.contentHash = incomingHash;
        changes.push({ name: skill.name, distribution: skill.distribution, oldRevision, revision, oldHash, hash: incomingHash, licenseChanged });
      }
    }

    if (changes.length) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const lines = [
      "# Weekly skills update",
      "",
      changes.length ? `Prepared ${changes.length} reviewed source change candidates.` : "No source content or license material changed.",
      "",
      "| Skill | Mode | Old revision | New revision | Content changed | License material changed |",
      "|---|---|---|---|---|---|",
      ...changes.map((change) => `| \`${change.name}\` | ${change.distribution} | \`${change.oldRevision.slice(0, 12)}\` | \`${change.revision.slice(0, 12)}\` | ${change.oldHash !== change.hash ? "yes" : "no"} | ${change.licenseChanged ? "yes" : "no"} |`),
      "",
      "Validation and tests are run by the workflow before this pull request is created or updated.",
      "The workflow does not merge this pull request.",
      "",
    ];
    await writeFile(report, lines.join("\n"));
    return changes;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  updateSkills(options)
    .then((changes) => console.log(changes.length ? `Prepared ${changes.length} skill updates.` : "All skills are current."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

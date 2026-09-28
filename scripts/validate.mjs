import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeRelativePath,
  treeHash,
  validateManifestShape,
  validateSkillDirectory,
} from "./lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export async function validateRepository(repositoryRoot = root) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "sources.json"), "utf8"));
  validateManifestShape(manifest);

  const snapshots = manifest.skills.filter((skill) => skill.distribution === "snapshot");
  const direct = manifest.skills.filter((skill) => skill.distribution === "direct");
  if (manifest.skills.length !== 23 || snapshots.length !== 20 || direct.length !== 3) {
    throw new Error("Expected exactly 23 skills, with 20 snapshots and three direct sources");
  }

  const expectedSnapshots = snapshots.map((skill) => skill.name).sort();
  const actualSnapshots = (await readdir(join(repositoryRoot, "skills"))).sort();
  if (JSON.stringify(expectedSnapshots) !== JSON.stringify(actualSnapshots)) {
    throw new Error("The skills directory must contain exactly the snapshot entries from sources.json");
  }

  for (const skill of snapshots) {
    const directory = join(repositoryRoot, "skills", skill.name);
    await validateSkillDirectory(directory, skill.name);
    const actualHash = await treeHash(directory);
    if (actualHash !== skill.contentHash) {
      throw new Error(`${skill.name} hash mismatch: expected ${skill.contentHash}, received ${actualHash}`);
    }
    if (skill.license.spdx === "NONE-DETECTED" || skill.license.notices.length === 0) {
      throw new Error(`${skill.name} cannot be a snapshot without a detected license and notice material`);
    }
    for (const notice of skill.license.notices) {
      assertSafeRelativePath(notice, `${skill.name}.license.notices`);
      await readFile(join(repositoryRoot, notice));
    }
  }

  const expectedDirect = ["nestjs-best-practices", "nestjs-testing-expert", "typescript-expert"];
  if (JSON.stringify(direct.map((skill) => skill.name).sort()) !== JSON.stringify(expectedDirect)) {
    throw new Error("The direct source allowlist does not match the approved architecture");
  }
  for (const skill of direct) {
    if (actualSnapshots.includes(skill.name)) {
      throw new Error(`${skill.name} is direct and must not be redistributed under skills/`);
    }
  }

  const claude = await readFile(join(repositoryRoot, "CLAUDE.md"), "utf8");
  if (claude !== "@AGENTS.md\n") throw new Error("CLAUDE.md must contain exactly @AGENTS.md and one newline");

  const agents = await readFile(join(repositoryRoot, "AGENTS.md"), "utf8");
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:ghp|github_pat|sk|AKIA)[_-][A-Za-z0-9_-]{12,}\b/,
    /\/(?:Users|home)\/[^/\s]+\//,
  ];
  if (forbidden.some((pattern) => pattern.test(agents))) {
    throw new Error("AGENTS.md contains a credential pattern or local home directory path");
  }

  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.devDependencies?.skills ?? "")) {
    throw new Error("The skills CLI must be pinned to an exact version");
  }

  return { total: 23, snapshots: 20, direct: 3 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateRepository()
    .then((result) => console.log(`Validated ${result.total} skills (${result.snapshots} snapshots, ${result.direct} direct).`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export async function readManifest(root) {
  return JSON.parse(await readFile(new URL("../sources.json", import.meta.url), "utf8"));
}

export async function collectFiles(root, current = "") {
  const directory = join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    const absolute = join(root, relative);
    const stats = await lstat(absolute);

    if (stats.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed: ${relative}`);
    }

    if (stats.isDirectory()) {
      files.push(...(await collectFiles(root, `${relative}/`)));
    } else if (stats.isFile()) {
      if (stats.size > 5 * 1024 * 1024) {
        throw new Error(`Skill file exceeds 5 MB: ${relative}`);
      }
      files.push(relative);
    }
  }

  return files;
}

export async function treeHash(root) {
  const hash = createHash("sha256");
  const files = await collectFiles(root);

  for (const relative of files) {
    let content = await readFile(join(root, relative));
    if (!content.includes(0)) {
      content = Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"));
    }
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function assertSafeRelativePath(value, label) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
}

export async function validateSkillDirectory(path, expectedName) {
  const skillFile = `${path}/SKILL.md`;
  const body = await readFile(skillFile, "utf8");
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`${expectedName} has invalid SKILL.md frontmatter`);
  if (!new RegExp(`^name:\\s*["']?${expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(match[1])) {
    throw new Error(`${expectedName} SKILL.md name does not match its manifest name`);
  }
  if (!/^description:\s*.+/m.test(match[1])) {
    throw new Error(`${expectedName} SKILL.md has no description`);
  }
}

export function validateManifestShape(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills)) {
    throw new Error("sources.json must use schemaVersion 1 and a skills array");
  }

  const names = new Set();
  for (const skill of manifest.skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
    names.add(skill.name);
    assertSafeRelativePath(skill.path, `${skill.name}.path`);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(skill.repository)) {
      throw new Error(`${skill.name}.repository must be a canonical HTTPS GitHub repository URL`);
    }
    if (!/^[a-f0-9]{40}$/.test(skill.revision)) throw new Error(`${skill.name}.revision must be a full commit SHA`);
    if (!/^[a-f0-9]{64}$/.test(skill.contentHash)) throw new Error(`${skill.name}.contentHash must be SHA 256`);
    if (!["snapshot", "direct"].includes(skill.distribution)) throw new Error(`${skill.name}.distribution is invalid`);
    if (!skill.license?.spdx || !Array.isArray(skill.license.evidence) || !Array.isArray(skill.license.notices)) {
      throw new Error(`${skill.name}.license is incomplete`);
    }
  }

  return names;
}

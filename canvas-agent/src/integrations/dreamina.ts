import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DreaminaIntegration = { command: string; binDir: string; skillFile?: string };
export type DreaminaCommand = { executable: string; env: NodeJS.ProcessEnv };

let cachedIntegration: DreaminaIntegration | null | undefined;

/** Locate the locally installed Dreamina CLI without requiring it to be on Canvas Agent's PATH. */
export function resolveDreaminaIntegration() {
    if (cachedIntegration !== undefined) return cachedIntegration;
    const command = dreaminaCandidates().find(isFile);
    if (!command) return (cachedIntegration = null);
    const commandDir = path.dirname(command);
    const binDir = dreaminaBinDir(command);
    const skillFile = dreaminaSkillCandidates(commandDir).find(isFile);
    return (cachedIntegration = { command, binDir, ...(skillFile ? { skillFile } : {}) });
}

/** Resolve the real executable behind the Windows wrapper so user prompts stay argv data instead of shell code. */
export function resolveDreaminaCommand(): DreaminaCommand | null {
    const integration = resolveDreaminaIntegration();
    if (!integration) return null;
    if (process.platform !== "win32" || path.extname(integration.command).toLowerCase() !== ".cmd") return { executable: integration.command, env: process.env };
    const executable = path.join(path.dirname(integration.command), "dreamina.exe");
    if (!isFile(executable)) return null;
    const script = fs.readFileSync(integration.command, "utf8");
    const env = { ...process.env };
    for (const key of ["HOME", "USERPROFILE"] as const) {
        const value = script.match(new RegExp(`set\\s+"${key}=([^"\\r\\n]+)"`, "i"))?.[1]?.trim();
        if (value) env[key] = value;
    }
    return { executable, env };
}

/** Expose the detected CLI to shell commands launched by Codex. */
export function withDreaminaPath(environment: NodeJS.ProcessEnv = process.env) {
    const integration = resolveDreaminaIntegration();
    if (!integration) return environment;
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
    const current = environment[pathKey] || "";
    const entries = current.split(path.delimiter).filter(Boolean);
    if (entries.some((entry) => samePath(entry, integration.binDir))) return environment;
    return { ...environment, [pathKey]: [integration.binDir, current].filter(Boolean).join(path.delimiter) };
}

/** Make the CLI-provided Skill available inside the isolated Infinite Canvas Codex workspace. */
export function installDreaminaSkill(workspacePath: string) {
    const source = resolveDreaminaIntegration()?.skillFile;
    if (!source) return false;
    const target = path.join(workspacePath, ".agents", "skills", "dreamina-cli", "SKILL.md");
    if (fs.existsSync(target)) return true;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return true;
}

function dreaminaCandidates() {
    const configured = process.env.DREAMINA_CLI_PATH?.trim();
    const fromPath = pathEntries().flatMap((directory) => process.platform === "win32" ? ["dreamina.cmd", "dreamina.exe"].map((name) => path.join(directory, name)) : [path.join(directory, "dreamina")]);
    const home = os.homedir();
    return unique([
        configured ? path.resolve(configured) : "",
        ...fromPath,
        ...(process.platform === "win32"
            ? [path.join(home, "Documents", "Codex", "bin", "dreamina.cmd"), path.join(home, "Documents", "Codex", "bin", "dreamina.exe")]
            : [path.join(home, ".local", "bin", "dreamina"), "/usr/local/bin/dreamina", "/usr/bin/dreamina"]),
    ]);
}

function dreaminaSkillCandidates(binDir: string) {
    const configured = process.env.DREAMINA_SKILL_PATH?.trim();
    const root = path.dirname(binDir);
    return unique([
        configured ? path.resolve(configured) : "",
        path.join(root, ".dreamina_cli", "dreamina", "SKILL.md"),
        path.join(os.homedir(), ".dreamina_cli", "dreamina", "SKILL.md"),
        path.join(os.homedir(), "Documents", "Codex", ".dreamina_cli", "dreamina", "SKILL.md"),
    ]);
}

/** Keep the .cmd wrapper ahead of a sibling .exe because the wrapper selects Dreamina's credential home. */
function dreaminaBinDir(command: string) {
    if (process.platform !== "win32" || path.extname(command).toLowerCase() !== ".cmd") return path.dirname(command);
    const shimDir = path.join(os.homedir(), ".infinite-canvas", "bin");
    const shim = path.join(shimDir, "dreamina.cmd");
    fs.mkdirSync(shimDir, { recursive: true });
    const content = `@echo off\r\ncall "${command}" %*\r\n`;
    if (!fs.existsSync(shim) || fs.readFileSync(shim, "utf8") !== content) fs.writeFileSync(shim, content);
    return shimDir;
}

function pathEntries() {
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
    return (process.env[pathKey] || "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function unique(values: string[]) {
    return Array.from(new Set(values.filter(Boolean)));
}

function isFile(filePath: string) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function samePath(left: string, right: string) {
    const normalize = (value: string) => {
        const resolved = path.resolve(value).replaceAll("\\", "/");
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

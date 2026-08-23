import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveDreaminaCommand, type DreaminaCommand } from "./dreamina.js";

export type DreaminaReference = { name?: string; dataUrl: string };
export type DreaminaGenerateInput = {
    kind: "image" | "video";
    prompt: string;
    modelVersion?: string;
    count?: number;
    size?: string;
    quality?: string;
    seconds?: number;
    resolution?: string;
    references?: DreaminaReference[];
    confirmedCreditUse?: boolean;
    creditQuoteId?: string;
};
export type DreaminaCreditQuote = {
    testMode: boolean;
    quoteId: string;
    credits: number;
    totalCredit: number | null;
    source: "test" | "dreamina_web" | "settled_history";
    evidenceCount: number;
    pricedAt: number;
    expiresAt: number;
};
export type DreaminaMedia = { id: string; kind: "image" | "video"; mimeType: string; dataUrl?: string; mediaId?: string; fileName?: string };
export type DreaminaTaskProgress = {
    phase: "submitted" | "queued" | "processing" | "awaiting_confirmation" | "downloading";
    genStatus: string;
    queueStatus?: string;
    queueIndex?: number;
    queueLength?: number;
    elapsedMs: number;
    unchangedMs: number;
    updatedAt: number;
};
export type DreaminaTaskResult =
    | { testMode: boolean; status: "pending"; submitId: string; progress?: DreaminaTaskProgress }
    | { testMode: boolean; status: "completed"; submitId?: string; items: DreaminaMedia[]; progress?: DreaminaTaskProgress }
    | { testMode: boolean; status: "failed"; submitId: string; error: string };
export type DreaminaCommandRunner = (command: DreaminaCommand, args: string[], timeoutMs?: number) => Promise<unknown>;
export type DreaminaWebQuoteProvider = (input: {
    kind: "image" | "video";
    modelVersion: string;
    count: number;
    size?: string;
    quality?: string;
    seconds?: number;
    resolution?: string;
    referenceCount: number;
    referenceTypes: Array<"image" | "video" | "audio" | "unknown">;
    promptLength: number;
    forceRefresh?: boolean;
}) => Promise<number>;

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const SUCCESS = new Set(["success", "succeeded", "completed", "done"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);
const TEXT_IMAGE_MODELS = new Set(["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]);
const REFERENCE_IMAGE_MODELS = new Set(["4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]);
const TEXT_VIDEO_MODELS = new Set(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"]);
const REFERENCE_VIDEO_MODELS = new Set(["seedance1.0fast", "seedance1.5pro", ...TEXT_VIDEO_MODELS]);

export class DreaminaGenerationService {
    private readonly command: DreaminaCommand | null;
    private readonly runCommand: DreaminaCommandRunner;
    private readonly testMode: boolean;
    private readonly requireCreditQuote: boolean;
    private readonly webQuote?: DreaminaWebQuoteProvider;
    private readonly now: () => number;
    private readonly media = new Map<string, { filePath: string; mimeType: string; expiresAt: number }>();
    private readonly taskDirectories = new Map<string, string>();
    private readonly taskResults = new Map<string, DreaminaTaskResult>();
    private readonly taskQueries = new Map<string, Promise<DreaminaTaskResult>>();
    private readonly taskObservations = new Map<string, { firstSeenAt: number; lastChangedAt: number; signature: string }>();
    private readonly creditQuotes = new Map<string, { fingerprint: string; credits: number; expiresAt: number }>();
    private cachedCredit: { totalCredit: number | null; expiresAt: number } | null = null;
    private creditRead: Promise<{ testMode: boolean; totalCredit: number | null }> | null = null;

    constructor(options: { command?: DreaminaCommand | null; runCommand?: DreaminaCommandRunner; testMode?: boolean; now?: () => number; requireCreditQuote?: boolean; webQuote?: DreaminaWebQuoteProvider } = {}) {
        this.command = options.command === undefined ? resolveDreaminaCommand() : options.command;
        this.runCommand = options.runCommand || runDreaminaCommand;
        this.testMode = options.testMode ?? process.env.CANVAS_AGENT_DREAMINA_TEST_MODE === "1";
        this.requireCreditQuote = options.requireCreditQuote ?? true;
        this.webQuote = options.webQuote;
        this.now = options.now || Date.now;
    }

    status() {
        return { available: this.testMode || Boolean(this.command), testMode: this.testMode, creditConfirmationRequired: !this.testMode, capabilities: ["image", "video"] };
    }

    async credit() {
        if (this.testMode) return { testMode: true, totalCredit: null };
        if (!this.command) throw new Error("未检测到本机即梦 CLI");
        const result = await this.runCommand(this.command, ["user_credit"], 30_000);
        const totalCredit = findNumber(result, ["total_credit", "totalCredit"]);
        if (totalCredit === undefined) throw new Error("即梦 CLI 未返回积分余额");
        return { testMode: false, totalCredit };
    }

    /**
     * Quote without submitting a generation. The CLI currently exposes settled commerce data only,
     * so a quote is issued only when the same account has a matching successful settlement.
     */
    async quote(input: DreaminaGenerateInput): Promise<DreaminaCreditQuote> {
        const pricedAt = this.now();
        if (this.testMode) return { testMode: true, quoteId: "test", credits: 0, totalCredit: null, source: "test", evidenceCount: 0, pricedAt, expiresAt: pricedAt + 120_000 };
        const calculated = await this.calculateQuote(input, { forceRefresh: true, includeBalance: true });
        const quoteId = crypto.randomBytes(24).toString("base64url");
        const expiresAt = pricedAt + 120_000;
        this.creditQuotes.set(quoteId, { fingerprint: quoteFingerprint(input), credits: calculated.credits, expiresAt });
        this.pruneCreditQuotes(pricedAt);
        return { testMode: false, quoteId, ...calculated, pricedAt, expiresAt };
    }

    async estimate(input: DreaminaGenerateInput): Promise<Omit<DreaminaCreditQuote, "quoteId" | "pricedAt" | "expiresAt">> {
        if (this.testMode) return { testMode: true, credits: 0, totalCredit: null, source: "test", evidenceCount: 0 };
        return { testMode: false, ...(await this.calculateQuote(input, { forceRefresh: false, includeBalance: false })) };
    }

    async generate(input: DreaminaGenerateInput): Promise<{ testMode: boolean; items: DreaminaMedia[] }> {
        const prompt = input.prompt?.trim();
        if (!prompt) throw new Error("请输入即梦生成提示词");
        if (input.kind !== "image" && input.kind !== "video") throw new Error("即梦生成类型无效");
        if (this.testMode) {
            if (input.kind !== "image") throw new Error("零积分测试模式仅提供本地模拟图片");
            return { testMode: true, items: mockImages(prompt, input.size, input.count) };
        }
        if (!input.confirmedCreditUse) throw new Error("真实即梦生成会消耗积分，请先明确确认");
        if (this.requireCreditQuote) await this.verifyCreditQuote(input);
        if (!this.command) throw new Error("未检测到本机即梦 CLI");
        return { testMode: false, items: await this.generateReal(input, prompt) };
    }

    /** Submit a real task without holding the browser request open for the full generation. */
    async start(input: DreaminaGenerateInput): Promise<DreaminaTaskResult> {
        const prompt = input.prompt?.trim();
        if (!prompt) throw new Error("请输入即梦生成提示词");
        if (input.kind !== "image" && input.kind !== "video") throw new Error("即梦生成类型无效");
        if (this.testMode) {
            const result = await this.generate(input);
            return { testMode: true, status: "completed", items: result.items };
        }
        if (!input.confirmedCreditUse) throw new Error("真实即梦生成会消耗积分，请先明确确认");
        if (this.requireCreditQuote) await this.verifyCreditQuote(input);
        if (!this.command) throw new Error("未检测到本机即梦 CLI");

        const jobDir = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-dreamina-submit-"));
        const inputDir = path.join(jobDir, "inputs");
        await mkdir(inputDir);
        try {
            const references = await writeReferences(input.references || [], inputDir);
            const args = generationArgs(input, prompt, references);
            let submitted: unknown;
            try {
                submitted = await this.runCommand(this.command, args, 120_000);
            } catch (error) {
                if (!(error instanceof Error) || !/响应超时|timed?\s*out/i.test(error.message)) throw error;
                const recentTasks = await this.runCommand(this.command, ["list_task", "--limit=20"], 30_000);
                const recoveredSubmitId = findRecentTaskSubmitId(recentTasks, prompt, args[0]);
                if (!recoveredSubmitId) throw error;
                submitted = { submit_id: recoveredSubmitId };
            }
            const submitId = findString(submitted, ["submit_id", "submitId", "task_id", "taskId", "id"]);
            if (!submitId) throw new Error("即梦 CLI 未返回任务 ID");
            const now = this.now();
            this.taskObservations.set(submitId, { firstSeenAt: now, lastChangedAt: now, signature: "submitted" });
            const progress: DreaminaTaskProgress = { phase: "submitted", genStatus: "submitted", elapsedMs: 0, unchangedMs: 0, updatedAt: now };
            const result: DreaminaTaskResult = { testMode: false, status: "pending", submitId, progress };
            this.taskResults.set(submitId, result);
            return result;
        } finally {
            await rm(jobDir, { recursive: true, force: true });
        }
    }

    /** Query an existing task. Safe to call after the canvas page has been refreshed. */
    async query(submitId: string): Promise<DreaminaTaskResult> {
        if (!/^[a-z0-9_-]{8,128}$/i.test(submitId)) throw new Error("即梦任务 ID 无效");
        if (!this.command) throw new Error("未检测到本机即梦 CLI");
        const cached = this.taskResults.get(submitId);
        if (cached?.status === "completed" || cached?.status === "failed") return cached;
        const active = this.taskQueries.get(submitId);
        if (active) return active;
        const query = this.queryOnce(submitId).finally(() => this.taskQueries.delete(submitId));
        this.taskQueries.set(submitId, query);
        return query;
    }

    async readMedia(mediaId: string) {
        const item = this.media.get(mediaId);
        if (!item || item.expiresAt <= Date.now()) {
            this.media.delete(mediaId);
            return null;
        }
        try {
            if (!(await stat(item.filePath)).isFile()) return null;
            return item;
        } catch {
            this.media.delete(mediaId);
            return null;
        }
    }

    private async calculateQuote(input: DreaminaGenerateInput, options: { forceRefresh?: boolean; includeBalance?: boolean } = {}) {
        if (!this.command) throw new Error("未检测到本机即梦 CLI");
        if (this.webQuote) {
            const references = input.references || [];
            const count = input.kind === "image" ? clamp(input.count || 1, 1, 10) : 1;
            const modelVersion = input.kind === "image"
                ? imageModelVersion(input.modelVersion, references.length > 0)
                : videoModelVersion(input.modelVersion, references.length > 0);
            const [credits, credit] = await Promise.all([
                this.webQuote({
                    kind: input.kind,
                    modelVersion,
                    count,
                    size: input.kind === "image" ? imageRatio(input.size) : videoRatio(input.size),
                    quality: input.kind === "image" ? imageResolution(input.quality, modelVersion) : undefined,
                    seconds: input.kind === "video" ? videoDuration(input.seconds, modelVersion) : undefined,
                    resolution: input.kind === "video" ? videoResolution(input.resolution, modelVersion) : undefined,
                    referenceCount: references.length,
                    referenceTypes: references.map(referenceMediaType),
                    promptLength: input.kind === "video" ? input.prompt.length : 0,
                    forceRefresh: options.forceRefresh,
                }),
                options.includeBalance === false ? Promise.resolve({ totalCredit: null }) : this.cachedCreditBalance(),
            ]);
            if (!Number.isInteger(credits) || credits < 0) throw new Error("即梦网页返回了无效积分，本次不会提交");
            if (credit.totalCredit !== null && credit.totalCredit < credits) throw new Error(`即梦积分不足：预计需要 ${credits}，当前余额 ${credit.totalCredit}`);
            return { credits, totalCredit: credit.totalCredit, evidenceCount: 0, source: "dreamina_web" as const };
        }
        const pricing = quotePricingKey(input);
        const [credit, tasks] = await Promise.all([
            options.includeBalance === false ? Promise.resolve({ totalCredit: null }) : this.cachedCreditBalance(),
            this.runCommand(this.command, ["list_task", "--gen_status=success", "--limit=100"], 30_000),
        ]);
        const settlements = matchingSettlementCredits(tasks, pricing);
        if (!settlements.length) {
            throw new Error(`即梦暂未为当前组合提供提交前报价，且本机没有可核验的同参数结算记录（${pricing.label}）。为避免未知扣费，本次不会提交。`);
        }
        const latest = settlements[0];
        const credits = input.kind === "image" ? latest.unitCredits * clamp(input.count || 1, 1, 10) : latest.unitCredits;
        if (!Number.isInteger(credits) || credits < 0) throw new Error("即梦历史结算无法换算为可靠的整数积分，本次不会提交");
        if (credit.totalCredit !== null && credit.totalCredit < credits) throw new Error(`即梦积分不足：预计需要 ${credits}，当前余额 ${credit.totalCredit}`);
        return { credits, totalCredit: credit.totalCredit, evidenceCount: settlements.length, source: "settled_history" as const };
    }

    private async verifyCreditQuote(input: DreaminaGenerateInput) {
        const quoteId = input.creditQuoteId || "";
        const quote = this.creditQuotes.get(quoteId);
        if (!quote || quote.expiresAt <= this.now()) throw new Error("即梦积分报价已失效，请重新报价并确认");
        if (quote.fingerprint !== quoteFingerprint(input)) throw new Error("输入方式或生成参数已变化，请重新报价并确认");
        const current = await this.calculateQuote(input, { forceRefresh: true, includeBalance: true });
        if (current.credits !== quote.credits) throw new Error(`即梦积分报价已从 ${quote.credits} 变为 ${current.credits}，请按新价格重新确认`);
        this.creditQuotes.delete(quoteId);
    }

    private pruneCreditQuotes(now: number) {
        for (const [quoteId, quote] of this.creditQuotes) if (quote.expiresAt <= now) this.creditQuotes.delete(quoteId);
    }

    private async cachedCreditBalance() {
        const now = this.now();
        if (this.cachedCredit && this.cachedCredit.expiresAt > now) return { testMode: false, totalCredit: this.cachedCredit.totalCredit };
        if (this.creditRead) return this.creditRead;
        const read = this.credit().then((credit) => {
            this.cachedCredit = { totalCredit: credit.totalCredit, expiresAt: this.now() + 30_000 };
            return credit;
        }).finally(() => {
            if (this.creditRead === read) this.creditRead = null;
        });
        this.creditRead = read;
        return read;
    }

    private async generateReal(input: DreaminaGenerateInput, prompt: string) {
        const jobDir = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-dreamina-"));
        const inputDir = path.join(jobDir, "inputs");
        const outputDir = path.join(jobDir, "outputs");
        await Promise.all([mkdir(inputDir), mkdir(outputDir)]);
        try {
            const references = await writeReferences(input.references || [], inputDir);
            const submitted = await this.runCommand(this.command!, generationArgs(input, prompt, references), 120_000);
            const submitId = findString(submitted, ["submit_id", "submitId", "task_id", "taskId", "id"]);
            if (!submitId) throw new Error("即梦 CLI 未返回任务 ID");
            const files = await this.waitForResult(submitId, outputDir);
            if (!files.length) throw new Error("即梦任务成功，但没有下载到媒体文件");
            const items = files.map((filePath) => this.registerMedia(filePath));
            setTimeout(() => void rm(jobDir, { recursive: true, force: true }), 60 * 60 * 1000).unref();
            return items;
        } catch (error) {
            await rm(jobDir, { recursive: true, force: true });
            throw error;
        }
    }

    private async queryOnce(submitId: string): Promise<DreaminaTaskResult> {
        let outputDir = this.taskDirectories.get(submitId);
        if (!outputDir) {
            outputDir = await mkdtemp(path.join(os.tmpdir(), `infinite-canvas-dreamina-result-${safeStem(submitId)}-`));
            this.taskDirectories.set(submitId, outputDir);
        }
        const result = await this.runCommand(this.command!, ["query_result", `--submit_id=${submitId}`, `--download_dir=${outputDir}`], 90_000);
        const status = findString(result, ["gen_status", "status", "task_status"]).toLowerCase();
        const progress = this.taskProgress(submitId, result, status);
        const files = await listMediaFiles(outputDir);
        if (files.length && (!status || SUCCESS.has(status))) {
            const completed: DreaminaTaskResult = { testMode: false, status: "completed", submitId, items: files.map((filePath) => this.registerMedia(filePath)), progress: { ...progress, phase: "downloading" } };
            this.taskResults.set(submitId, completed);
            return completed;
        }
        if (FAILED.has(status)) {
            const failed: DreaminaTaskResult = { testMode: false, status: "failed", submitId, error: findString(result, ["fail_reason", "error", "message", "msg"]) || `即梦任务失败：${status}` };
            this.taskResults.set(submitId, failed);
            return failed;
        }
        const pending: DreaminaTaskResult = { testMode: false, status: "pending", submitId, progress };
        this.taskResults.set(submitId, pending);
        return pending;
    }

    private taskProgress(submitId: string, result: unknown, genStatus: string): DreaminaTaskProgress {
        const now = this.now();
        const queueStatus = findString(result, ["queue_status"]);
        const queueIndex = findNumber(result, ["queue_idx", "queue_index"]);
        const queueLength = findNumber(result, ["queue_length"]);
        const signature = [genStatus, queueStatus, queueIndex, queueLength].join(":");
        const current = this.taskObservations.get(submitId) || { firstSeenAt: now, lastChangedAt: now, signature };
        if (current.signature !== signature) {
            current.signature = signature;
            current.lastChangedAt = now;
        }
        this.taskObservations.set(submitId, current);
        const elapsedMs = Math.max(0, now - current.firstSeenAt);
        const unchangedMs = Math.max(0, now - current.lastChangedAt);
        const normalizedQueue = queueStatus.toLowerCase();
        const phase = normalizedQueue && normalizedQueue !== "finish" && normalizedQueue !== "finished"
            ? "queued"
            : (normalizedQueue === "finish" || normalizedQueue === "finished") && genStatus === "querying" && elapsedMs >= 60_000
              ? "awaiting_confirmation"
              : "processing";
        return {
            phase,
            genStatus: genStatus || "querying",
            ...(queueStatus ? { queueStatus } : {}),
            ...(queueIndex !== undefined ? { queueIndex } : {}),
            ...(queueLength !== undefined ? { queueLength } : {}),
            elapsedMs,
            unchangedMs,
            updatedAt: now,
        };
    }

    private async waitForResult(submitId: string, outputDir: string) {
        const deadline = Date.now() + 15 * 60 * 1000;
        while (Date.now() < deadline) {
            const result = await this.runCommand(this.command!, ["query_result", `--submit_id=${submitId}`, `--download_dir=${outputDir}`], 90_000);
            const status = findString(result, ["gen_status", "status", "task_status"]).toLowerCase();
            const files = await listMediaFiles(outputDir);
            if (files.length && (!status || SUCCESS.has(status))) return files;
            if (FAILED.has(status)) throw new Error(findString(result, ["fail_reason", "error", "message", "msg"]) || `即梦任务失败：${status}`);
            await delay(2000);
        }
        throw new Error("即梦生成超时，请稍后在任务列表中查询");
    }

    private registerMedia(filePath: string): DreaminaMedia {
        const extension = path.extname(filePath).toLowerCase();
        const kind = VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
        const mediaId = crypto.randomBytes(18).toString("hex");
        const mimeType = mediaMimeType(extension);
        this.media.set(mediaId, { filePath, mimeType, expiresAt: Date.now() + 60 * 60 * 1000 });
        return { id: crypto.randomUUID(), kind, mimeType, mediaId, fileName: path.basename(filePath) };
    }
}

export async function runDreaminaCommand(command: DreaminaCommand, args: string[], timeoutMs = 90_000) {
    return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(command.executable, args, { env: command.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("即梦 CLI 响应超时"));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += String(chunk).slice(0, 2_000_000)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk).slice(0, 200_000)));
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `即梦 CLI 退出码 ${code}`));
            try {
                resolve(parseJsonOutput(stdout));
            } catch (error) {
                reject(error);
            }
        });
    });
}

type QuotePricingKey = { taskType: string; benefitType: string; label: string };

function quotePricingKey(input: DreaminaGenerateInput): QuotePricingKey {
    const references = input.references?.length || 0;
    if (input.kind === "image") {
        const modelVersion = imageModelVersion(input.modelVersion, references > 0);
        const resolution = imageResolution(input.quality, modelVersion);
        // This benefit key is verified against the CLI's own settled commerce_info. Unknown
        // model families deliberately have no guessed mapping and therefore cannot be submitted.
        if (modelVersion !== "5.0") throw new Error(`即梦 ${modelVersion} 尚无可核验的本地积分映射，本次不会提交`);
        return {
            taskType: references ? "image2image" : "text2image",
            benefitType: `image_basic_v5_${resolution}`,
            label: `${references ? "图生图" : "文生图"} · ${modelVersion} · ${resolution} · ${references} 张参考图`,
        };
    }
    throw new Error("即梦视频 CLI 尚未提供可核验的提交前积分报价，本次不会提交");
}

function quoteFingerprint(input: DreaminaGenerateInput) {
    const normalized = {
        kind: input.kind,
        modelVersion: input.modelVersion || "",
        count: input.kind === "image" ? clamp(input.count || 1, 1, 10) : 1,
        size: input.size || "",
        quality: input.quality || "",
        seconds: input.seconds || 0,
        resolution: input.resolution || "",
        prompt: crypto.createHash("sha256").update(input.prompt || "").digest("hex"),
        references: (input.references || []).map((reference) => ({
            type: referenceMediaType(reference),
            name: reference.name || "",
            content: crypto.createHash("sha256").update(reference.dataUrl || "").digest("hex"),
        })),
    };
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function referenceMediaType(reference: DreaminaReference): "image" | "video" | "audio" | "unknown" {
    const mimeType = /^data:([^;,]+)/i.exec(reference.dataUrl || "")?.[1]?.toLowerCase() || "";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    const extension = path.extname(reference.name || "").toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    if (VIDEO_EXTENSIONS.has(extension)) return "video";
    if ([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"].includes(extension)) return "audio";
    return "unknown";
}

function matchingSettlementCredits(value: unknown, pricing: QuotePricingKey) {
    const tasks = Array.isArray(value) ? value : [];
    const matches: Array<{ unitCredits: number }> = [];
    for (const task of tasks) {
        if (!task || typeof task !== "object" || Array.isArray(task)) continue;
        const record = task as Record<string, unknown>;
        if (String(record.gen_task_type || "") !== pricing.taskType) continue;
        const commerce = record.commerce_info;
        if (!commerce || typeof commerce !== "object" || Array.isArray(commerce)) continue;
        const commerceRecord = commerce as Record<string, unknown>;
        const triplets = Array.isArray(commerceRecord.triplets) ? commerceRecord.triplets : [];
        const hasBenefit = triplets.some((triplet) => triplet && typeof triplet === "object" && !Array.isArray(triplet) && String((triplet as Record<string, unknown>).benefit_type || "") === pricing.benefitType);
        if (!hasBenefit) continue;
        const creditCount = Number(commerceRecord.credit_count);
        if (!Number.isInteger(creditCount) || creditCount < 0) continue;
        const result = record.result_json;
        const imageCount = result && typeof result === "object" && !Array.isArray(result) && Array.isArray((result as Record<string, unknown>).images)
            ? Math.max(1, ((result as Record<string, unknown>).images as unknown[]).length)
            : 1;
        const unitCredits = creditCount / imageCount;
        if (Number.isInteger(unitCredits)) matches.push({ unitCredits });
    }
    return matches;
}

function generationArgs(input: DreaminaGenerateInput, prompt: string, references: string[]) {
    if (input.kind === "image") {
        const modelVersion = imageModelVersion(input.modelVersion, references.length > 0);
        const args = [references.length ? "image2image" : "text2image", `--prompt=${prompt}`, `--model_version=${modelVersion}`, `--resolution_type=${imageResolution(input.quality, modelVersion)}`, `--generate_num=${clamp(input.count || 1, 1, 10)}`, `--ratio=${imageRatio(input.size)}`, "--poll=0"];
        for (const filePath of references.slice(0, 10)) args.push(`--images=${filePath}`);
        return args;
    }
    const modelVersion = videoModelVersion(input.modelVersion, references.length > 0);
    const args = [references.length ? "image2video" : "text2video", `--prompt=${prompt}`, `--model_version=${modelVersion}`, `--duration=${videoDuration(input.seconds, modelVersion)}`, `--video_resolution=${videoResolution(input.resolution, modelVersion)}`, "--poll=0"];
    if (references.length) args.push(`--image=${references[0]}`);
    else args.push(`--ratio=${videoRatio(input.size)}`);
    return args;
}

async function writeReferences(references: DreaminaReference[], directory: string) {
    const paths: string[] = [];
    for (const [index, reference] of references.slice(0, 10).entries()) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(reference.dataUrl || "");
        if (!match) throw new Error("即梦参考图必须是有效的本地图片");
        const extension = imageExtension(match[1]);
        const filePath = path.join(directory, `${String(index + 1).padStart(2, "0")}-${safeStem(reference.name || "reference")}${extension}`);
        await writeFile(filePath, Buffer.from(match[2], "base64"));
        paths.push(filePath);
    }
    return paths;
}

async function listMediaFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map((entry) => entry.isDirectory() ? listMediaFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
    return files.flat().filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
}

function parseJsonOutput(output: string) {
    const text = output.trim();
    if (!text) return {};
    try {
        return JSON.parse(text) as unknown;
    } catch {}
    for (let index = text.lastIndexOf("{"); index >= 0; index = text.lastIndexOf("{", index - 1)) {
        try {
            return JSON.parse(text.slice(index)) as unknown;
        } catch {}
    }
    throw new Error(`即梦 CLI 返回了无法解析的结果：${text.slice(0, 240)}`);
}

function findString(value: unknown, keys: string[]): string {
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findString(item, keys);
            if (found) return found;
        }
        return "";
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) if (record[key] !== undefined && record[key] !== null && String(record[key])) return String(record[key]);
    for (const item of Object.values(record)) {
        const found = findString(item, keys);
        if (found) return found;
    }
    return "";
}

function findNumber(value: unknown, keys: string[]): number | undefined {
    const found = findString(value, keys);
    if (!found) return undefined;
    const number = Number(found);
    return Number.isFinite(number) ? number : undefined;
}

function findRecentTaskSubmitId(value: unknown, prompt: string, taskType: string) {
    const tasks = Array.isArray(value) ? value : [];
    for (const task of tasks) {
        if (!task || typeof task !== "object" || Array.isArray(task)) continue;
        const record = task as Record<string, unknown>;
        if (String(record.prompt || "").trim() !== prompt) continue;
        if (String(record.gen_task_type || "").trim() !== taskType) continue;
        if (FAILED.has(String(record.gen_status || "").toLowerCase())) continue;
        const submitId = findString(record, ["submit_id", "submitId", "task_id", "taskId", "id"]);
        if (submitId) return submitId;
    }
    return "";
}

function mockImages(prompt: string, size = "1:1", count = 1): DreaminaMedia[] {
    const [width, height] = mockDimensions(size);
    return Array.from({ length: clamp(count, 1, 10) }, (_, index) => {
        const title = escapeXml(prompt.slice(0, 90));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#312e81"/><stop offset=".55" stop-color="#7c3aed"/><stop offset="1" stop-color="#db2777"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.78}" cy="${height * 0.22}" r="${Math.min(width, height) * 0.16}" fill="#fff" opacity=".18"/><text x="50%" y="46%" text-anchor="middle" fill="white" font-family="sans-serif" font-size="${Math.max(22, Math.round(Math.min(width, height) / 18))}" font-weight="700">Dreamina 零积分测试 ${index + 1}</text><text x="50%" y="56%" text-anchor="middle" fill="white" opacity=".86" font-family="sans-serif" font-size="${Math.max(14, Math.round(Math.min(width, height) / 30))}">${title}</text></svg>`;
        return { id: crypto.randomUUID(), kind: "image", mimeType: "image/svg+xml", dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` };
    });
}

function mockDimensions(size: string) {
    const match = /^(\d+):(\d+)$/.exec(size);
    if (!match) return [768, 768];
    const ratio = Number(match[1]) / Number(match[2]);
    return ratio >= 1 ? [768, Math.round(768 / ratio)] : [Math.round(768 * ratio), 768];
}

function imageModelVersion(value: string | undefined, hasReferences: boolean) {
    const version = value || "5.0";
    const supported = hasReferences ? REFERENCE_IMAGE_MODELS : TEXT_IMAGE_MODELS;
    if (!supported.has(version)) throw new Error(`即梦模型 ${version} 不支持${hasReferences ? "参考图生图" : "文生图"}`);
    return version;
}

function imageResolution(quality: string | undefined, modelVersion: string) {
    const requested = quality?.toLowerCase();
    const supported = modelVersion === "3.0" || modelVersion === "3.1" ? ["1k", "2k"] : modelVersion === "5.0Pro" ? ["1.5k", "2k", "4k"] : ["2k", "4k"];
    if (requested && supported.includes(requested)) return requested;
    if (requested === "high") return supported.at(-1)!;
    return supported.includes("2k") ? "2k" : supported[0];
}

function videoModelVersion(value: string | undefined, hasReferences: boolean) {
    const version = value || (hasReferences ? "seedance2.0_vip" : "seedance2.0fast");
    const supported = hasReferences ? REFERENCE_VIDEO_MODELS : TEXT_VIDEO_MODELS;
    if (!supported.has(version)) throw new Error(`即梦模型 ${version} 不支持${hasReferences ? "图生视频" : "文生视频"}`);
    return version;
}

function videoDuration(seconds: number | undefined, modelVersion: string) {
    if (modelVersion === "seedance1.0fast") return clamp(seconds || 5, 5, 10);
    if (modelVersion === "seedance1.5pro") return clamp(seconds || 5, 5, 12);
    return clamp(seconds || 5, 4, modelVersion === "seedance2.5" ? 30 : 15);
}

function videoResolution(value: string | undefined, modelVersion: string) {
    const requested = `${value || "720"}`.toLowerCase().replace(/p$/, "");
    const supported = modelVersion === "seedance2.5" ? ["480", "720"] : modelVersion === "seedance2.0_vip" ? ["720", "1080", "4k"] : ["720"];
    return `${supported.includes(requested) ? requested : "720"}${requested === "4k" && supported.includes(requested) ? "" : "p"}`;
}

function imageRatio(size = "1:1") {
    const supported = new Set(["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
    if (supported.has(size)) return size;
    const dimensions = /^(\d+)x(\d+)$/.exec(size);
    return dimensions ? closestRatio(Number(dimensions[1]) / Number(dimensions[2]), [...supported]) : "1:1";
}

function videoRatio(size = "16:9") {
    const mapped: Record<string, string> = { "1280x720": "16:9", "720x1280": "9:16", "1024x1024": "1:1", "1792x1024": "16:9", "1024x1792": "9:16", auto: "16:9" };
    return mapped[size] || imageRatio(size);
}

function closestRatio(value: number, ratios: string[]) {
    return ratios.reduce((best, current) => Math.abs(parseRatio(current) - value) < Math.abs(parseRatio(best) - value) ? current : best, ratios[0]);
}

function parseRatio(value: string) {
    const [left, right] = value.split(":").map(Number);
    return left / right;
}

function imageExtension(mimeType: string) {
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/webp") return ".webp";
    if (mimeType === "image/gif") return ".gif";
    if (mimeType === "image/avif") return ".avif";
    return ".png";
}

function mediaMimeType(extension: string) {
    const types: Record<string, string> = { ".avif": "image/avif", ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".mp4": "video/mp4", ".webm": "video/webm" };
    return types[extension] || "application/octet-stream";
}

function safeStem(value: string) {
    return path.parse(value).name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "reference";
}

function escapeXml(value: string) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.round(Number(value) || min)));
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

import crypto from "node:crypto";

import { DreaminaPricingRuleStore } from "./dreamina-pricing-rules.js";

export type DreaminaWebQuoteRequest = {
    kind: "image" | "video";
    modelVersion: string;
    count: number;
    size?: string;
    quality?: string;
    seconds?: number;
    resolution?: string;
    referenceCount: number;
    referenceTypes: string[];
    promptLength: number;
};

type BridgeTask = DreaminaWebQuoteRequest & { requestId: string };
type PendingTask = {
    task: BridgeTask;
    cacheKey: string;
    resolve: (credits: number) => void;
    reject: (error: Error) => void;
    expiresAt: number;
};

const CLIENT_TTL_MS = 45_000;
const QUOTE_TIMEOUT_MS = 20_000;
const DISPLAY_RULE_TTL_MS = 24 * 60 * 60 * 1000;
const SUBMIT_RULE_TTL_MS = 30 * 60 * 1000;
export const DREAMINA_QUOTE_BRIDGE_VERSION = "0.2.0";

/**
 * Read-only rendezvous between Canvas Agent and the optional Edge quote bridge.
 * The public bridge endpoints never receive prompts, images, Agent tokens, or generation commands.
 */
export class DreaminaWebQuoteBridge {
    private readonly clients = new Map<string, number>();
    private readonly queue: PendingTask[] = [];
    private readonly active = new Map<string, PendingTask>();
    private readonly inFlight = new Map<string, Promise<number>>();
    private readonly waiters = new Set<() => void>();
    private readonly rules: DreaminaPricingRuleStore;
    private readonly now: () => number;
    private lastClientId = "";

    constructor(options: { rules?: DreaminaPricingRuleStore; now?: () => number } = {}) {
        this.now = options.now || Date.now;
        this.rules = options.rules || new DreaminaPricingRuleStore({ now: this.now });
    }

    status(now = this.now()) {
        this.prune(now);
        return { connected: [...this.clients.values()].some((seenAt) => now - seenAt <= CLIENT_TTL_MS) };
    }

    async quote(input: DreaminaWebQuoteRequest, options: { forceRefresh?: boolean } = {}) {
        this.validateInput(input);
        const cacheKey = quoteCacheKey(input);
        const accountKey = this.preferredClientId();
        const verified = accountKey ? this.rules.get(accountKey, cacheKey, options.forceRefresh ? SUBMIT_RULE_TTL_MS : DISPLAY_RULE_TTL_MS) : null;
        if (verified) return verified.creditsPerUnit * input.count;
        if (!this.status().connected) throw new Error("即梦网页实时报价桥未连接，本次不会提交");
        const inFlightKey = `${accountKey || "pending"}|${cacheKey}`;
        const running = this.inFlight.get(inFlightKey);
        if (running) return (await running) * input.count;

        const requestId = crypto.randomBytes(18).toString("base64url");
        const unitQuote = new Promise<number>((resolve, reject) => {
            // 网页只读取单份价格；张数由 Agent 本地乘算，避免数量变化时重复操作网页。
            const pending: PendingTask = { task: { ...input, count: 1, requestId }, cacheKey, resolve, reject, expiresAt: this.now() + QUOTE_TIMEOUT_MS };
            this.queue.push(pending);
            this.wakeWaiters();
            const timer = setTimeout(() => {
                if (!this.removePending(requestId)) return;
                reject(new Error("即梦网页实时报价超时，本次不会提交"));
            }, QUOTE_TIMEOUT_MS);
            timer.unref();
        });
        this.inFlight.set(inFlightKey, unitQuote);
        void unitQuote.then(
            () => this.inFlight.delete(inFlightKey),
            () => this.inFlight.delete(inFlightKey),
        );
        return (await unitQuote) * input.count;
    }

    async poll(clientId: string, waitMs = 20_000, version = "") {
        this.validateClientId(clientId);
        if (version !== DREAMINA_QUOTE_BRIDGE_VERSION) throw new Error(`即梦报价桥版本不兼容，请在 Edge 扩展页重新加载 ${DREAMINA_QUOTE_BRIDGE_VERSION}`);
        this.clients.set(clientId, this.now());
        this.lastClientId = clientId;
        const task = this.takeTask();
        if (task) return task;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.waiters.delete(done);
                resolve();
            }, Math.max(0, Math.min(waitMs, 25_000)));
            timer.unref();
            const done = () => {
                clearTimeout(timer);
                this.waiters.delete(done);
                resolve();
            };
            this.waiters.add(done);
        });
        this.clients.set(clientId, this.now());
        this.lastClientId = clientId;
        return this.takeTask();
    }

    complete(clientId: string, requestId: string, result: { ok?: boolean; credits?: unknown; error?: unknown }) {
        this.validateClientId(clientId);
        this.clients.set(clientId, this.now());
        this.lastClientId = clientId;
        const pending = this.active.get(requestId);
        if (!pending) return false;
        this.active.delete(requestId);
        if (!result.ok) {
            pending.reject(new Error(String(result.error || "即梦网页无法计算当前参数的积分")));
            return true;
        }
        const credits = Number(result.credits);
        if (!Number.isInteger(credits) || credits < 0) {
            pending.reject(new Error("即梦网页返回了无效积分，本次不会提交"));
            return true;
        }
        this.rules.set(clientId, pending.cacheKey, credits);
        pending.resolve(credits);
        return true;
    }

    private takeTask() {
        this.prune(this.now());
        const pending = this.queue.shift();
        if (!pending) return null;
        this.active.set(pending.task.requestId, pending);
        return pending.task;
    }

    private removePending(requestId: string) {
        if (this.active.delete(requestId)) return true;
        const index = this.queue.findIndex((item) => item.task.requestId === requestId);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        return true;
    }

    private wakeWaiters() {
        for (const waiter of this.waiters) waiter();
        this.waiters.clear();
    }

    private prune(now: number) {
        for (const [clientId, seenAt] of this.clients) if (now - seenAt > CLIENT_TTL_MS) this.clients.delete(clientId);
        for (const pending of [...this.queue, ...this.active.values()]) {
            if (pending.expiresAt > now || !this.removePending(pending.task.requestId)) continue;
            pending.reject(new Error("即梦网页实时报价超时，本次不会提交"));
        }
    }

    private validateClientId(clientId: string) {
        if (!/^[a-z0-9_-]{16,128}$/i.test(clientId)) throw new Error("即梦报价桥标识无效");
    }

    private validateInput(input: DreaminaWebQuoteRequest) {
        if (input.kind !== "image" && input.kind !== "video") throw new Error("即梦报价类型无效");
        if (!/^[a-z0-9._-]{1,40}$/i.test(input.modelVersion)) throw new Error("即梦报价模型无效");
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > 10) throw new Error("即梦报价数量无效");
        if (!Number.isInteger(input.referenceCount) || input.referenceCount < 0 || input.referenceCount > 10) throw new Error("即梦参考图数量无效");
        if (!Number.isInteger(input.promptLength) || input.promptLength < 0 || input.promptLength > 20_000) throw new Error("即梦提示词长度无效");
        if (!Array.isArray(input.referenceTypes) || input.referenceTypes.length !== input.referenceCount || input.referenceTypes.some((type) => !/^(?:image|video|audio|unknown)$/.test(type))) throw new Error("即梦参考素材类型无效");
    }

    private preferredClientId() {
        if (this.lastClientId) return this.lastClientId;
        return [...this.clients.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    }
}

function quoteCacheKey(input: DreaminaWebQuoteRequest) {
    return [input.kind, input.modelVersion, input.size || "", input.quality || "", input.seconds || "", input.resolution || "", input.promptLength, input.referenceTypes.join(",")].join("|").toLowerCase();
}

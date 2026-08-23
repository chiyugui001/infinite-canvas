import i18n from "@/i18n";
import { imageToDataUrl } from "@/services/image-storage";
import { fetchAgentJson } from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";
import type { ReferenceImage } from "@/types/image";

type DreaminaStatus = { ok?: boolean; available: boolean; testMode: boolean; creditConfirmationRequired: boolean; capabilities: Array<"image" | "video"> };
export type DreaminaCreditSource = "test" | "dreamina_web" | "settled_history";
export type DreaminaCreditQuote = { ok?: boolean; testMode: boolean; quoteId: string; credits: number; totalCredit: number | null; source: DreaminaCreditSource; evidenceCount: number; pricedAt: number; expiresAt: number };
export type DreaminaCreditEstimate = Omit<DreaminaCreditQuote, "quoteId" | "pricedAt" | "expiresAt"> & { bridgeConnected?: boolean };
type DreaminaItem = { id: string; kind: "image" | "video"; mimeType: string; dataUrl?: string; mediaId?: string; fileName?: string };
export type DreaminaTaskProgress = { phase: "submitting" | "submitted" | "queued" | "processing" | "awaiting_confirmation" | "downloading"; genStatus: string; queueStatus?: string; queueIndex?: number; queueLength?: number; elapsedMs: number; unchangedMs: number; updatedAt: number };
type DreaminaResponse = { ok?: boolean; testMode: boolean; status: "pending" | "completed" | "failed"; submitId?: string; items?: DreaminaItem[]; error?: string; progress?: DreaminaTaskProgress };
export type DreaminaRequestOptions = { signal?: AbortSignal; onTask?: (submitId: string) => void; onProgress?: (progress: DreaminaTaskProgress) => void };
export type DreaminaInput = {
    kind: "image" | "video";
    prompt: string;
    modelVersion: string;
    count?: number;
    size?: string;
    quality?: string;
    seconds?: number;
    resolution?: string;
    references?: Array<{ name: string; dataUrl: string }>;
    confirmedCreditUse?: boolean;
    creditQuoteId?: string;
};

type PendingCreditConfirmation = { input: DreaminaInput; endpoint: string; token: string; resolve: (quoteId: string | null) => void };
let pendingCreditConfirmations: PendingCreditConfirmation[] = [];
let creditConfirmationTimer: number | null = null;
const preparedCreditQuotes = new Map<string, string[]>();

export async function estimateDreaminaCredits(input: DreaminaInput, signal?: AbortSignal) {
    const { endpoint, token } = connection();
    return await fetchAgentJson<DreaminaCreditEstimate>(endpoint, token, "/dreamina/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
    });
}

/** Quote and confirm before the canvas creates loading nodes or marks generation as started. */
export async function prepareDreaminaGeneration(input: DreaminaInput, taskCount = 1) {
    const { endpoint, token } = connection();
    const count = Math.max(1, Math.min(10, Math.floor(taskCount) || 1));
    const unitInput = input.kind === "image" ? { ...input, count: 1 } : input;
    const quotes = await Promise.all(Array.from({ length: count }, () => fetchAgentJson<DreaminaCreditQuote>(endpoint, token, "/dreamina/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(unitInput),
    })));
    const credits = quotes.reduce((sum, quote) => sum + quote.credits, 0);
    const confirmed = credits === 0 || window.confirm(creditConfirmationMessage(
        Array.from({ length: count }, () => unitInput),
        quotes[0]?.totalCredit ?? null,
        credits,
        quotes.reduce((sum, quote) => sum + quote.evidenceCount, 0),
        quotes[0]?.source || "settled_history",
    ));
    if (!confirmed) return false;
    const key = dreaminaInputKey(unitInput);
    preparedCreditQuotes.set(key, [...(preparedCreditQuotes.get(key) || []), ...quotes.map((quote) => quote.quoteId)]);
    return true;
}

export async function requestDreaminaImages(input: Omit<DreaminaInput, "kind" | "references">, references: ReferenceImage[], options?: DreaminaRequestOptions) {
    const response = await generate({ ...input, kind: "image", references: await serializeReferences(references) }, options);
    const images = (response.items || []).filter((item) => item.kind === "image").map((item) => item.dataUrl || mediaUrl(item.mediaId));
    if (!images.length) throw new Error(i18n.t("dreamina.noMedia"));
    return images;
}

export async function requestDreaminaVideo(input: Omit<DreaminaInput, "kind" | "references">, references: ReferenceImage[], options?: DreaminaRequestOptions) {
    const response = await generate({ ...input, kind: "video", references: await serializeReferences(references.slice(0, 1)) }, options);
    const item = (response.items || []).find((current) => current.kind === "video");
    if (!item) throw new Error(i18n.t("dreamina.noVideo"));
    return { url: item.dataUrl || mediaUrl(item.mediaId), mimeType: item.mimeType || "video/mp4" };
}

export async function resumeDreaminaImages(submitId: string, options?: DreaminaRequestOptions) {
    const response = await pollTask(submitId, options);
    const images = (response.items || []).filter((item) => item.kind === "image").map((item) => item.dataUrl || mediaUrl(item.mediaId));
    if (!images.length) throw new Error(i18n.t("dreamina.noMedia"));
    return images;
}

async function generate(input: DreaminaInput, options?: DreaminaRequestOptions) {
    const { endpoint, token } = connection();
    const status = await fetchAgentJson<DreaminaStatus>(endpoint, token, "/dreamina/status", { signal: options?.signal });
    if (!status.available) throw new Error(i18n.t("dreamina.unavailable"));
    const creditQuoteId = status.creditConfirmationRequired ? takePreparedCreditQuote(input) || await confirmCreditUse(input, endpoint, token) : undefined;
    if (status.creditConfirmationRequired && !creditQuoteId) throw new DOMException(i18n.t("common.requestCanceled"), "AbortError");
    const submitStartedAt = Date.now();
    const reportSubmitting = () => {
        const now = Date.now();
        options?.onProgress?.({ phase: "submitting", genStatus: "submitting", elapsedMs: now - submitStartedAt, unchangedMs: now - submitStartedAt, updatedAt: now });
    };
    reportSubmitting();
    const submittingTimer = window.setInterval(reportSubmitting, 1000);
    let started: DreaminaResponse;
    try {
        started = await fetchAgentJson<DreaminaResponse>(endpoint, token, "/dreamina/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...input, confirmedCreditUse: status.creditConfirmationRequired, creditQuoteId }),
            signal: options?.signal,
        });
    } finally {
        window.clearInterval(submittingTimer);
    }
    if (started.status === "completed") return started;
    if (started.status === "failed") throw new Error(started.error || i18n.t("dreamina.noMedia"));
    if (!started.submitId) throw new Error(i18n.t("dreamina.noMedia"));
    options?.onTask?.(started.submitId);
    if (started.progress) options?.onProgress?.(started.progress);
    return pollTask(started.submitId, options);
}

async function pollTask(submitId: string, options?: DreaminaRequestOptions): Promise<DreaminaResponse> {
    const { endpoint, token } = connection();
    while (true) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const result = await fetchAgentJson<DreaminaResponse>(endpoint, token, `/dreamina/tasks/${encodeURIComponent(submitId)}`, { signal: options?.signal });
        if (result.progress) options?.onProgress?.(result.progress);
        if (result.status === "completed") return result;
        if (result.status === "failed") throw new Error(result.error || i18n.t("dreamina.noMedia"));
        await delay(3000, options?.signal);
    }
}

function connection() {
    const state = useAgentStore.getState();
    const endpoint = state.url.trim().replace(/\/$/, "");
    const token = state.token.trim();
    if (!state.connected || !endpoint || !token) throw new Error(i18n.t("dreamina.agentRequired"));
    return { endpoint, token };
}

function confirmCreditUse(input: DreaminaInput, endpoint: string, token: string) {
    return new Promise<string | null>((resolve) => {
        pendingCreditConfirmations.push({ input, endpoint, token, resolve });
        if (creditConfirmationTimer !== null) return;
        creditConfirmationTimer = window.setTimeout(() => void flushCreditConfirmations(), 80);
    });
}

async function flushCreditConfirmations() {
    const pending = pendingCreditConfirmations;
    pendingCreditConfirmations = [];
    creditConfirmationTimer = null;
    if (!pending.length) return;
    const first = pending[0];
    let quotes: DreaminaCreditQuote[];
    try {
        quotes = await Promise.all(pending.map((item) => fetchAgentJson<DreaminaCreditQuote>(item.endpoint, item.token, "/dreamina/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(item.input),
        })));
    } catch (error) {
        window.alert(error instanceof Error ? error.message : i18n.t("dreamina.quoteUnavailable"));
        pending.forEach((item) => item.resolve(null));
        return;
    }
    const totalCredit = quotes[0]?.totalCredit ?? null;
    const quotedCredits = quotes.reduce((sum, quote) => sum + quote.credits, 0);
    const confirmed = quotedCredits === 0 || window.confirm(creditConfirmationMessage(pending.map((item) => item.input), totalCredit, quotedCredits, quotes.reduce((sum, quote) => sum + quote.evidenceCount, 0), quotes[0]?.source || "settled_history"));
    pending.forEach((item, index) => item.resolve(confirmed ? quotes[index].quoteId : null));
}

function creditConfirmationMessage(inputs: DreaminaInput[], totalCredit: number | null, quotedCredits: number, evidenceCount: number, source: DreaminaCreditSource) {
    const imageTasks = inputs.filter((input) => input.kind === "image");
    const videoTasks = inputs.filter((input) => input.kind === "video");
    const imageCount = imageTasks.reduce((sum, input) => sum + Math.max(1, input.count || 1), 0);
    const usage = [
        imageTasks.length ? i18n.t("dreamina.creditUsageImages", { count: imageCount, tasks: imageTasks.length }) : "",
        videoTasks.length ? i18n.t("dreamina.creditUsageVideos", { count: videoTasks.length }) : "",
    ].filter(Boolean).join(i18n.t("dreamina.creditUsageSeparator"));
    const models = [...new Set(inputs.map((input) => input.modelVersion).filter(Boolean))].join(", ");
    const parameters = [...new Set(inputs.map((input) => input.kind === "image"
        ? [input.quality, input.size].filter(Boolean).join(" · ")
        : [input.resolution, input.seconds ? `${input.seconds}s` : "", input.size].filter(Boolean).join(" · ")).filter(Boolean))].join(" / ");
    return i18n.t("dreamina.creditConfirm", {
        usage,
        models: models || "-",
        parameters: parameters || "-",
        balance: totalCredit === null ? i18n.t("dreamina.creditBalanceUnknown") : totalCredit.toLocaleString(),
        credits: quotedCredits.toLocaleString(),
        evidenceCount: evidenceCount.toLocaleString(),
        quoteBasis: source === "dreamina_web" ? i18n.t("dreamina.webQuoteBasis") : i18n.t("dreamina.historyQuoteBasis", { evidenceCount: evidenceCount.toLocaleString() }),
    });
}

function takePreparedCreditQuote(input: DreaminaInput) {
    const key = dreaminaInputKey(input);
    const quotes = preparedCreditQuotes.get(key);
    const quoteId = quotes?.shift();
    if (!quotes?.length) preparedCreditQuotes.delete(key);
    return quoteId;
}

function dreaminaInputKey(input: DreaminaInput) {
    return JSON.stringify({
        kind: input.kind,
        modelVersion: input.modelVersion,
        count: input.kind === "image" ? Math.max(1, Math.min(10, Number(input.count) || 1)) : 1,
        size: input.size || "",
        quality: input.quality || "",
        seconds: input.seconds || 0,
        resolution: input.resolution || "",
        prompt: fastHash(input.prompt || ""),
        references: (input.references || []).map((reference) => ({ name: reference.name, type: referenceType(reference), content: fastHash(reference.dataUrl || "") })),
    });
}

function referenceType(reference: { name: string; dataUrl: string }) {
    const mime = /^data:([^;,]+)/i.exec(reference.dataUrl || "")?.[1]?.toLowerCase() || "";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    const name = reference.name.toLowerCase();
    if (/\.(?:avif|gif|jpe?g|png|webp)$/.test(name)) return "image";
    if (/\.(?:m4v|mov|mp4|webm)$/.test(name)) return "video";
    if (/\.(?:aac|flac|m4a|mp3|ogg|wav)$/.test(name)) return "audio";
    return "unknown";
}

function fastHash(value: string) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${(hash >>> 0).toString(36)}`;
}

async function serializeReferences(references: ReferenceImage[]) {
    return await Promise.all(references.map(async (reference, index) => ({ name: reference.name || `reference-${index + 1}.png`, dataUrl: await imageToDataUrl(reference) })));
}

function mediaUrl(mediaId?: string) {
    if (!mediaId) throw new Error(i18n.t("dreamina.noMedia"));
    const { endpoint, token } = connection();
    return `${endpoint}/dreamina/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(token)}`;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DreaminaGenerationService } from "./dreamina-generation.js";

test("Dreamina zero-credit test mode generates local images without calling the CLI", async () => {
    let called = false;
    const service = new DreaminaGenerationService({
        testMode: true,
        command: { executable: "must-not-run", env: {} },
        runCommand: async () => {
            called = true;
            throw new Error("CLI must not run in zero-credit tests");
        },
    });

    assert.deepEqual(service.status(), { available: true, testMode: true, creditConfirmationRequired: false, capabilities: ["image", "video"] });
    const result = await service.generate({ kind: "image", prompt: "free smoke test", count: 2, size: "16:9" });
    assert.equal(called, false);
    assert.equal(result.testMode, true);
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((item) => item.dataUrl?.startsWith("data:image/svg+xml;base64,")));
});

test("Dreamina real mode refuses generation without explicit credit confirmation", async () => {
    let called = false;
    const service = new DreaminaGenerationService({
        command: { executable: "dreamina", env: {} },
        runCommand: async () => {
            called = true;
            return {};
        },
    });

    await assert.rejects(() => service.generate({ kind: "image", prompt: "must confirm" }), /消耗积分/);
    assert.equal(called, false);
});

test("Dreamina credit lookup is read-only and returns only the usable balance", async () => {
    const calls: string[][] = [];
    const service = new DreaminaGenerationService({
        requireCreditQuote: false,
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            return { total_credit: 15035, user_id: "private", user_name: "private" };
        },
    });

    assert.deepEqual(await service.credit(), { testMode: false, totalCredit: 15035 });
    assert.deepEqual(calls, [["user_credit"]]);
});

test("Dreamina zero-credit mode never offers a mock video that could hide an untested paid path", async () => {
    const service = new DreaminaGenerationService({ testMode: true, command: null });
    await assert.rejects(() => service.generate({ kind: "video", prompt: "no paid test" }), /仅提供本地模拟图片/);
});

test("Dreamina selected model versions are forwarded as CLI argv without starting the real CLI", async () => {
    const calls: string[][] = [];
    const service = new DreaminaGenerationService({
        requireCreditQuote: false,
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            throw new Error("fake runner stopped before submission");
        },
    });

    await assert.rejects(() => service.generate({ kind: "image", prompt: "model smoke test", modelVersion: "5.0Pro", quality: "1.5k", confirmedCreditUse: true }), /fake runner/);
    await assert.rejects(() => service.generate({ kind: "video", prompt: "model smoke test", modelVersion: "seedance2.5", resolution: "480", seconds: 30, confirmedCreditUse: true }), /fake runner/);
    assert.ok(calls[0].includes("--model_version=5.0Pro"));
    assert.ok(calls[0].includes("--resolution_type=1.5k"));
    assert.ok(calls[1].includes("--model_version=seedance2.5"));
    assert.ok(calls[1].includes("--video_resolution=480p"));
    assert.ok(calls[1].includes("--duration=30"));
});

test("Dreamina resumable tasks return immediately and can be queried after a page refresh", async () => {
    const calls: string[][] = [];
    const service = new DreaminaGenerationService({
        requireCreditQuote: false,
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            if (args[0] !== "query_result") return { submit_id: "task_12345678" };
            const outputDir = args.find((arg) => arg.startsWith("--download_dir="))?.slice("--download_dir=".length);
            assert.ok(outputDir);
            await writeFile(path.join(outputDir, "result.png"), Buffer.from("local zero-credit fixture"));
            return { submit_id: "task_12345678", gen_status: "success" };
        },
    });

    const started = await service.start({ kind: "image", prompt: "resumable smoke test", confirmedCreditUse: true });
    assert.equal(started.status, "pending");
    assert.equal(started.submitId, "task_12345678");
    assert.equal(started.progress?.phase, "submitted");
    const completed = await service.query("task_12345678");
    assert.equal(completed.status, "completed");
    assert.equal(completed.status === "completed" && completed.items.length, 1);
    assert.equal(calls[0][0], "text2image");
    assert.equal(calls[1][0], "query_result");
});

test("Dreamina progress surfaces a likely platform confirmation step without submitting another task", async () => {
    let now = 0;
    const service = new DreaminaGenerationService({
        requireCreditQuote: false,
        now: () => now,
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => args[0] === "query_result"
            ? { submit_id: "task_progress_1", gen_status: "querying", queue_info: { queue_idx: 0, queue_length: 0, queue_status: "Finish" } }
            : { submit_id: "task_progress_1" },
    });

    await service.start({ kind: "image", prompt: "progress smoke test", confirmedCreditUse: true });
    now = 61_000;
    const result = await service.query("task_progress_1");
    assert.equal(result.status, "pending");
    assert.equal(result.progress?.phase, "awaiting_confirmation");
    assert.equal(result.progress?.genStatus, "querying");
    assert.equal(result.progress?.queueStatus, "Finish");
    assert.equal(result.progress?.elapsedMs, 61_000);
});

test("Dreamina recovers the task id from recent tasks when submission times out after the platform accepted it", async () => {
    const calls: string[][] = [];
    const service = new DreaminaGenerationService({
        requireCreditQuote: false,
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            if (args[0] === "list_task") {
                return [
                    { submit_id: "recovered_task_123", prompt: "侧视图", gen_task_type: "image2image", gen_status: "querying" },
                    { submit_id: "old_failed_task", prompt: "侧视图", gen_task_type: "image2image", gen_status: "fail" },
                ];
            }
            throw new Error("即梦 CLI 响应超时");
        },
    });

    const started = await service.start({ kind: "image", prompt: "侧视图", references: [{ dataUrl: "data:image/png;base64,bG9jYWw=" }], confirmedCreditUse: true });
    assert.equal(started.status, "pending");
    assert.equal(started.submitId, "recovered_task_123");
    assert.equal(calls[0][0], "image2image");
    assert.deepEqual(calls[1], ["list_task", "--limit=20"]);
});

test("Dreamina quotes from matching settled commerce data and revalidates before submission", async () => {
    const calls: string[][] = [];
    const settled = [{
        gen_task_type: "text2image",
        gen_status: "success",
        result_json: { images: [{}] },
        commerce_info: {
            credit_count: 5,
            triplets: [{ resource_type: "aigc", resource_id: "generate_img", benefit_type: "image_basic_v5_2k" }],
        },
    }];
    const service = new DreaminaGenerationService({
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            if (args[0] === "user_credit") return { total_credit: 100 };
            if (args[0] === "list_task") return settled;
            return { submit_id: "quoted_task_123" };
        },
    });
    const input = { kind: "image" as const, prompt: "quoted prompt", modelVersion: "5.0", quality: "2k", count: 2 };
    const quote = await service.quote(input);
    assert.equal(quote.credits, 10);
    assert.equal(quote.totalCredit, 100);
    assert.equal(quote.source, "settled_history");
    assert.equal(calls.some((args) => args[0] === "text2image"), false);

    const started = await service.start({ ...input, confirmedCreditUse: true, creditQuoteId: quote.quoteId });
    assert.equal(started.status, "pending");
    assert.equal(started.submitId, "quoted_task_123");
    assert.equal(calls.filter((args) => args[0] === "list_task").length, 2);
    assert.equal(calls.at(-1)?.[0], "text2image");
});

test("Dreamina uses the Edge web quote and rechecks it before submission", async () => {
    let quoteCalls = 0;
    let creditCalls = 0;
    const refreshes: Array<boolean | undefined> = [];
    const service = new DreaminaGenerationService({
        command: { executable: "dreamina", prefixArgs: [] },
        webQuote: async (input) => {
            quoteCalls += 1;
            refreshes.push(input.forceRefresh);
            assert.equal(input.referenceCount, 1);
            assert.deepEqual(input.referenceTypes, ["image"]);
            assert.equal(input.promptLength, 0);
            return input.count * 8;
        },
        runCommand: async (_command, args) => {
            if (args[0] === "user_credit") {
                creditCalls += 1;
                return { total_credit: 100 };
            }
            return { submit_id: "web_quote_task_123" };
        },
    });
    const input = { kind: "image" as const, prompt: "web quoted", modelVersion: "5.0Pro", quality: "2k", count: 1, references: [{ dataUrl: "data:image/png;base64,AA==" }] };
    const estimate = await service.estimate(input);
    assert.equal(estimate.credits, 8);
    assert.equal(estimate.totalCredit, null);
    assert.equal(creditCalls, 0);
    const quote = await service.quote(input);
    assert.equal(quote.credits, 8);
    assert.equal(quote.source, "dreamina_web");
    await assert.rejects(() => service.start({ ...input, prompt: "changed prompt", confirmedCreditUse: true, creditQuoteId: quote.quoteId }), /重新报价/);
    const started = await service.start({ ...input, confirmedCreditUse: true, creditQuoteId: quote.quoteId });
    assert.equal(started.status, "pending");
    assert.equal(quoteCalls, 3);
    assert.deepEqual(refreshes, [false, true, true]);
    assert.equal(creditCalls, 1);
});

test("Dreamina sends video prompt length and reference media types to the quote provider", async () => {
    const service = new DreaminaGenerationService({
        command: { executable: "dreamina", prefixArgs: [] },
        webQuote: async (input) => {
            assert.equal(input.kind, "video");
            assert.equal(input.promptLength, 6);
            assert.deepEqual(input.referenceTypes, ["video"]);
            return 45;
        },
    });
    const estimate = await service.estimate({ kind: "video", prompt: "123456", modelVersion: "seedance2.0mini", references: [{ name: "clip.mp4", dataUrl: "data:video/mp4;base64,AA==" }] });
    assert.equal(estimate.credits, 45);
});

test("Dreamina blocks an unpriced combination before any generation command", async () => {
    const calls: string[][] = [];
    const service = new DreaminaGenerationService({
        command: { executable: "fake-dreamina", env: {} },
        runCommand: async (_command, args) => {
            calls.push(args);
            if (args[0] === "user_credit") return { total_credit: 100 };
            if (args[0] === "list_task") return [];
            throw new Error("generation must not run");
        },
    });
    await assert.rejects(() => service.quote({ kind: "image", prompt: "unknown", modelVersion: "5.0", quality: "2k" }), /不会提交/);
    assert.equal(calls.some((args) => args[0] === "text2image"), false);
});

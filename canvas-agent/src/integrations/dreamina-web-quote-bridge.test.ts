import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DreaminaPricingRuleStore } from "./dreamina-pricing-rules.js";
import { DREAMINA_QUOTE_BRIDGE_VERSION, DreaminaWebQuoteBridge, type DreaminaWebQuoteRequest } from "./dreamina-web-quote-bridge.js";

const imageInput: DreaminaWebQuoteRequest = { kind: "image", modelVersion: "5.0", count: 1, size: "1:1", quality: "2k", referenceCount: 1, referenceTypes: ["image"], promptLength: 0 };

function fixture(now: () => number = Date.now) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "dreamina-price-rule-test-"));
    const filePath = path.join(directory, "rules.json");
    const rules = new DreaminaPricingRuleStore({ filePath, now });
    const bridge = new DreaminaWebQuoteBridge({ rules, now });
    return { bridge, filePath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("Dreamina web quote bridge returns only read-only pricing fields and persists verified rules", async () => {
    let now = 100_000;
    const { bridge, filePath, cleanup } = fixture(() => now);
    const clientId = "edge_quote_bridge_123456";
    try {
        await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        const quotePromise = bridge.quote({ ...imageInput, count: 3 });
        const task = await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        assert.ok(task?.requestId);
        assert.equal(task?.count, 1);
        assert.equal("prompt" in (task || {}), false);
        assert.equal("images" in (task || {}), false);
        assert.equal(bridge.complete(clientId, task!.requestId, { ok: true, credits: 8 }), true);
        assert.equal(await quotePromise, 24);

        assert.equal(await bridge.quote({ ...imageInput, count: 2 }), 16);
        assert.equal(await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION), null);

        const restarted = new DreaminaWebQuoteBridge({ rules: new DreaminaPricingRuleStore({ filePath, now: () => now }), now: () => now });
        await restarted.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        assert.equal(await restarted.quote({ ...imageInput, count: 4 }), 32);

        // 24 小时内可展示；超过 30 分钟且扩展离线时，提交前强制复核会失败关闭。
        now += 31 * 60 * 1000;
        restarted.status();
        assert.equal(await restarted.quote({ ...imageInput, count: 4 }), 32);
        await assert.rejects(() => restarted.quote(imageInput, { forceRefresh: true }), /未连接/);
    } finally {
        cleanup();
    }
});

test("Dreamina web quote bridge coalesces concurrent forced refreshes", async () => {
    const { bridge, cleanup } = fixture();
    const clientId = "edge_quote_bridge_coalesce";
    try {
        await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        const input: DreaminaWebQuoteRequest = { kind: "image", modelVersion: "5.0Pro", count: 1, quality: "4k", referenceCount: 0, referenceTypes: [], promptLength: 0 };
        const first = bridge.quote(input, { forceRefresh: true });
        const second = bridge.quote({ ...input, count: 3 }, { forceRefresh: true });
        const task = await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        assert.equal(task?.count, 1);
        bridge.complete(clientId, task!.requestId, { ok: true, credits: 12 });
        assert.equal(await first, 12);
        assert.equal(await second, 36);
        assert.equal(await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION), null);
    } finally {
        cleanup();
    }
});

test("Dreamina web quote bridge rejects invalid results and outdated extensions", async () => {
    const { bridge, cleanup } = fixture();
    const clientId = "edge_quote_bridge_abcdef";
    try {
        await assert.rejects(() => bridge.poll(clientId, 0, "0.1.1"), /版本不兼容/);
        await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        const quotePromise = bridge.quote({ ...imageInput, modelVersion: "5.0Pro", quality: "2k", referenceCount: 0, referenceTypes: [] });
        const task = await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        bridge.complete(clientId, task!.requestId, { ok: true, credits: -1 });
        await assert.rejects(quotePromise, /无效积分/);
    } finally {
        cleanup();
    }
});

test("Dreamina pricing keys separate video prompt lengths and material types", async () => {
    const { bridge, cleanup } = fixture();
    const clientId = "edge_quote_bridge_video_keys";
    try {
        await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        const base: DreaminaWebQuoteRequest = { kind: "video", modelVersion: "seedance2.0mini", count: 1, size: "16:9", seconds: 5, resolution: "720p", referenceCount: 0, referenceTypes: [], promptLength: 8 };
        const first = bridge.quote(base);
        const firstTask = await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        bridge.complete(clientId, firstTask!.requestId, { ok: true, credits: 30 });
        assert.equal(await first, 30);

        const second = bridge.quote({ ...base, promptLength: 9 });
        const secondTask = await bridge.poll(clientId, 0, DREAMINA_QUOTE_BRIDGE_VERSION);
        assert.notEqual(secondTask?.requestId, firstTask?.requestId);
        bridge.complete(clientId, secondTask!.requestId, { ok: true, credits: 30 });
        assert.equal(await second, 30);
    } finally {
        cleanup();
    }
});

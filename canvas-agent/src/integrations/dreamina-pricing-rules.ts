import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../config.js";

const SCHEMA_VERSION = 1;
const MAX_RULES = 800;
const MAX_RULE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type PricingRule = {
    accountKey: string;
    pricingKey: string;
    creditsPerUnit: number;
    verifiedAt: number;
};

type PricingRuleFile = { schemaVersion: number; rules: PricingRule[] };

/** Persist only verified numeric tariffs; prompts and media contents never enter this file. */
export class DreaminaPricingRuleStore {
    private readonly filePath: string;
    private readonly now: () => number;
    private readonly rules = new Map<string, PricingRule>();

    constructor(options: { filePath?: string; now?: () => number } = {}) {
        this.filePath = options.filePath || path.join(CONFIG_DIR, "dreamina-pricing-rules.json");
        this.now = options.now || Date.now;
        this.load();
    }

    get(accountKey: string, pricingKey: string, maxAgeMs: number) {
        const rule = this.rules.get(ruleId(accountKey, pricingKey));
        if (!rule || this.now() - rule.verifiedAt > maxAgeMs) return null;
        return rule;
    }

    set(accountKey: string, pricingKey: string, creditsPerUnit: number) {
        if (!accountKey || !pricingKey || !Number.isInteger(creditsPerUnit) || creditsPerUnit < 0) return;
        const rule = { accountKey, pricingKey, creditsPerUnit, verifiedAt: this.now() };
        this.rules.set(ruleId(accountKey, pricingKey), rule);
        this.prune();
        this.save();
    }

    private load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PricingRuleFile;
            if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.rules)) return;
            for (const rule of parsed.rules) {
                if (!rule || typeof rule !== "object" || !rule.accountKey || !rule.pricingKey || !Number.isInteger(rule.creditsPerUnit) || rule.creditsPerUnit < 0 || !Number.isFinite(rule.verifiedAt)) continue;
                this.rules.set(ruleId(rule.accountKey, rule.pricingKey), rule);
            }
            this.prune();
        } catch {}
    }

    private prune() {
        const oldest = this.now() - MAX_RULE_AGE_MS;
        for (const [id, rule] of this.rules) if (rule.verifiedAt < oldest) this.rules.delete(id);
        const sorted = [...this.rules.entries()].sort((a, b) => b[1].verifiedAt - a[1].verifiedAt);
        for (const [id] of sorted.slice(MAX_RULES)) this.rules.delete(id);
    }

    private save() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, rules: [...this.rules.values()] }, null, 2));
        fs.renameSync(temporary, this.filePath);
    }
}

function ruleId(accountKey: string, pricingKey: string) {
    return `${accountKey}\n${pricingKey}`;
}

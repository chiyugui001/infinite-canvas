import { useEffect, useMemo, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, Square } from "lucide-react";
import { App, Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, dreaminaModelVersion, isDreaminaModel, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { estimateDreaminaCredits, prepareDreaminaGeneration, type DreaminaCreditEstimate, type DreaminaInput } from "@/services/api/dreamina";
import { getNodeDefinition } from "@/lib/canvas/node-registry";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const [creditEstimate, setCreditEstimate] = useState<{ loading: boolean; value?: DreaminaCreditEstimate; error?: string }>({ loading: false });
    const dreamina = isDreaminaModel(config.model, mode === "video" ? "video" : "image");
    const referenceCount = hasImageContent ? 1 : mentionReferences.filter((reference) => reference.kind === "image").length;
    const generationPromptPrefix = getNodeDefinition(node.type)?.useBuiltinPanel?.promptPrefix || "";
    const dreaminaInput = useMemo(
        // 视频报价会把提示词长度纳入官方报价键；图片当前只按模型与生成参数计价。
        () => buildDreaminaInput(mode, config, mode === "video" ? generationPromptPrefix + prompt : "", referenceCount),
        [config.count, config.model, config.quality, config.size, config.videoSeconds, config.vquality, generationPromptPrefix, mode, prompt, referenceCount],
    );

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    useEffect(() => {
        if (!dreamina || !dreaminaInput) {
            setCreditEstimate({ loading: false });
            return;
        }
        const controller = new AbortController();
        let retryTimer: number | null = null;
        const readEstimate = () => {
            setCreditEstimate((current) => ({ ...current, loading: true, error: undefined }));
            void estimateDreaminaCredits(dreaminaInput, controller.signal)
                .then((value) => setCreditEstimate({ loading: false, value }))
                .catch((error) => {
                    if (controller.signal.aborted) return;
                    setCreditEstimate({ loading: false, error: error instanceof Error ? error.message : t("dreamina.liveCreditUnavailable") });
                    retryTimer = window.setTimeout(readEstimate, 3_000);
                });
        };
        const timer = window.setTimeout(readEstimate, 300);
        return () => {
            window.clearTimeout(timer);
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            controller.abort();
        };
    }, [dreamina, dreaminaInput, t]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!text || isRunning || preparing) return;
        if (dreamina && dreaminaInput) {
            setPreparing(true);
            try {
                const taskCount = mode === "image" ? Math.max(1, Math.min(10, Number(config.count) || 1)) : 1;
                if (!(await prepareDreaminaGeneration({ ...dreaminaInput, prompt: generationPromptPrefix + text }, taskCount))) return;
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("dreamina.quoteUnavailable"));
                return;
            } finally {
                setPreparing(false);
            }
        }
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={() => void submit()}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {dreamina ? <DreaminaLiveCredit estimate={creditEstimate} count={mode === "image" ? Math.max(1, Number(config.count) || 1) : 1} kind={mode === "video" ? "video" : "image"} /> : null}
                    <Button
                        type="primary"
                        className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                        danger={isRunning}
                        disabled={preparing || (!isRunning && !prompt.trim())}
                        onClick={() => (isRunning ? onStop(node.id) : void submit())}
                        aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                    >
                        <span className="flex items-center gap-1.5">
                            {isRunning ? (
                                <>
                                    <LoaderCircle className="size-4 animate-spin" />
                                    <Square className="size-3.5 fill-current" />
                                    <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                                </>
                            ) : preparing ? (
                                <LoaderCircle className="size-4 animate-spin" />
                            ) : (
                                <ArrowUp className="size-4" />
                            )}
                        </span>
                    </Button>
                </div>
            </div>
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Modal>
        </div>
    );
}

function DreaminaLiveCredit({ estimate, count, kind }: { estimate: { loading: boolean; value?: DreaminaCreditEstimate; error?: string }; count: number; kind: "image" | "video" }) {
    const { t } = useTranslation();
    if (estimate.loading) return <span className="whitespace-nowrap text-[11px] opacity-60">{t("dreamina.liveCreditLoading")}</span>;
    if (!estimate.value) return <Tooltip title={estimate.error || t("dreamina.liveCreditUnavailable")}><span className="whitespace-nowrap text-[11px] opacity-60">{t("dreamina.liveCreditUnavailable")}</span></Tooltip>;
    const perImage = estimate.value.credits / Math.max(1, count);
    const label = kind === "video"
        ? t("dreamina.liveCreditVideo", { credits: estimate.value.credits })
        : t("dreamina.liveCreditPerImage", { credits: Number.isInteger(perImage) ? perImage : perImage.toFixed(1) });
    return <Tooltip title={t("dreamina.liveCreditTotal", { credits: estimate.value.credits })}><span className="whitespace-nowrap text-xs font-medium tabular-nums">{label}</span></Tooltip>;
}

function buildDreaminaInput(mode: CanvasNodeGenerationMode, config: AiConfig, prompt: string, referenceCount: number): DreaminaInput | null {
    const references = Array.from({ length: Math.max(0, Math.min(10, referenceCount)) }, (_, index) => ({ name: `reference-${index + 1}.png`, dataUrl: "" }));
    if (mode === "image" && isDreaminaModel(config.model, "image")) return {
        kind: "image",
        prompt,
        modelVersion: dreaminaModelVersion(config.model, "image"),
        count: Math.max(1, Math.min(10, Number(config.count) || 1)),
        size: config.size,
        quality: config.quality,
        references,
    };
    if (mode === "video" && isDreaminaModel(config.model, "video")) return {
        kind: "video",
        prompt,
        modelVersion: dreaminaModelVersion(config.model, "video"),
        size: config.size,
        seconds: Number(config.videoSeconds) || undefined,
        resolution: config.vquality,
        references: references.slice(0, 1),
    };
    return null;
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}

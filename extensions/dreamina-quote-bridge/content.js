let quoteQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "dreamina-read-price") return false;
  // 单次网页读取失败不能毒化后续串行任务。
  quoteQueue = quoteQueue.catch(() => undefined).then(() => readPrice(message.task));
  quoteQueue.then((creditsPerUnit) => sendResponse({ ok: true, creditsPerUnit })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function readPrice(task) {
  await waitFor(() => document.querySelectorAll('[role="combobox"]').length >= 2, "即梦网页未登录或生成面板未加载");
  return task.kind === "video" ? readVideoPrice(task) : readImagePrice(task);
}

async function readImagePrice(task) {
  await selectCombobox(0, "图片生成");
  const modelLabels = { "5.0": "图片 5.0 Lite", "5.0Pro": "图片 5.0 Pro" };
  const modelLabel = modelLabels[task.modelVersion];
  if (!modelLabel) throw new Error(`暂不支持即梦图片 ${task.modelVersion} 的网页报价`);
  await selectCombobox(1, modelLabel);

  const requestedResolution = normalizeResolution(task.quality);
  const settingsButton = await waitFor(findImageSettingsButton, "即梦生成参数按钮不可用");
  if (!normalize(settingsButton.textContent).toUpperCase().includes(requestedResolution)) {
    const resolutionLabel = requestedResolution === "1.5K" ? "标清 1.5K" : requestedResolution === "4K" ? "超清 4K" : "高清 2K";
    await selectVisibleOption(settingsButton, resolutionLabel);
    await waitFor(() => normalize(findImageSettingsButton()?.textContent).toUpperCase().includes(requestedResolution), "即梦清晰度切换失败");
    await delay(250);
  }
  return await readVisibleCredits(true);
}

async function readVideoPrice(task) {
  if (task.referenceCount > 0) {
    const kinds = [...new Set(task.referenceTypes || [])].join("、") || "未知";
    throw new Error(`即梦网页精确报价暂不能安全注入${kinds}参考素材，本次不会按估算提交`);
  }
  await selectCombobox(0, "视频生成");
  const modelLabels = {
    "seedance1.0": "即梦 Seedance 1.0",
    "seedance1.0fast": "即梦 Seedance 1.0 Fast",
    "seedance1.5pro": "即梦 Seedance 1.5 Pro",
    "seedance2.0": "即梦 Seedance 2.0",
    "seedance2.0fast": "即梦 Seedance 2.0 Fast",
    "seedance2.0_vip": "即梦 Seedance 2.0 VIP",
    "seedance2.0fast_vip": "即梦 Seedance 2.0 Fast VIP",
    "seedance2.0mini": "即梦 Seedance 2.0 mini",
    "seedance2.5": "即梦 Seedance 2.5",
  };
  const modelLabel = modelLabels[task.modelVersion];
  if (!modelLabel) throw new Error(`暂不支持即梦视频 ${task.modelVersion} 的网页报价`);
  await selectCombobox(1, modelLabel);
  await setPromptLength(task.promptLength || 0);

  const settingsButton = await waitFor(findVideoSettingsButton, "即梦视频参数按钮不可用");
  const requestedRatio = String(task.size || "16:9");
  const requestedResolution = normalizeVideoResolution(task.resolution);
  const settingsText = normalize(settingsButton.textContent).toUpperCase();
  if (!settingsText.includes(requestedRatio) || !settingsText.includes(requestedResolution)) {
    if (!settingsText.includes(requestedRatio)) await selectVisibleOption(settingsButton, requestedRatio);
    if (!normalize(findVideoSettingsButton()?.textContent).toUpperCase().includes(requestedResolution)) await selectVisibleOption(findVideoSettingsButton(), requestedResolution);
    await waitFor(() => {
      const text = normalize(findVideoSettingsButton()?.textContent).toUpperCase();
      return text.includes(requestedRatio) && text.includes(requestedResolution);
    }, "即梦视频比例或清晰度切换失败");
  }

  const seconds = Math.max(1, Math.round(Number(task.seconds) || 5));
  const durationButton = await waitFor(() => visibleElements("button").find((element) => /^\d+\s*s$/i.test(normalize(element.textContent))) || null, "即梦视频时长按钮不可用");
  if (Number.parseInt(normalize(durationButton.textContent), 10) !== seconds) {
    click(durationButton);
    const input = await waitFor(() => visibleElements('input[type="number"], input[role="spinbutton"]').at(0) || null, "即梦视频时长输入不可用");
    setNativeInputValue(input, String(seconds));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    await waitFor(() => Number.parseInt(normalize(durationButton.textContent), 10) === seconds, "即梦视频时长切换失败");
  }
  await delay(350);
  return await readVisibleCredits(false);
}

async function selectCombobox(index, label) {
  const box = await waitFor(() => document.querySelectorAll('[role="combobox"]')[index] || null, `即梦网页没有 ${label} 选择器`);
  if (normalize(box.textContent).startsWith(label)) return;
  click(box);
  const option = await waitFor(() => textElementStartingWith('[role="option"]', label), `即梦网页没有选项 ${label}`);
  click(option);
  await waitFor(() => normalize(document.querySelectorAll('[role="combobox"]')[index]?.textContent).startsWith(label), `即梦 ${label} 切换失败`);
  await delay(180);
}

async function setPromptLength(length) {
  const editor = await waitFor(() => visibleElements('[contenteditable="true"][role="textbox"], [contenteditable="true"]').at(-1) || null, "即梦视频提示词输入框不可用");
  const text = "测".repeat(Math.max(0, Math.min(20_000, Number(length) || 0)));
  if ((editor.textContent || "").length === text.length) return;
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  if (!document.execCommand("insertText", false, text)) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  await delay(250);
}

async function selectVisibleOption(toggle, text) {
  let option = findRadioByText(text);
  if (!option) {
    click(toggle);
    option = await waitFor(() => findRadioByText(text), `即梦网页没有 ${text} 选项`);
  }
  click(option);
  await delay(150);
}

async function readVisibleCredits(expectPerImage) {
  const priceElement = await waitFor(() => findPriceElement(expectPerImage), "即梦网页没有显示实时积分");
  const match = normalize(priceElement.textContent).match(/(\d+(?:\.\d+)?)/);
  const credits = Number(match?.[1]);
  if (!Number.isFinite(credits) || credits < 0) throw new Error("即梦网页积分格式无效");
  return credits;
}

function findImageSettingsButton() {
  return visibleElements("button").find((element) => /(?:智能|21:9|16:9|3:2|4:3|1:1|3:4|2:3|9:16).*?(?:1K|1\.5K|2K|4K).*?\d+/i.test(normalize(element.textContent))) || null;
}

function findVideoSettingsButton() {
  return visibleElements("button").find((element) => /(?:21:9|16:9|3:2|4:3|1:1|3:4|2:3|9:16).*?(?:480P|720P|1080P|4K).*?\d+/i.test(normalize(element.textContent))) || null;
}

function findPriceElement(expectPerImage) {
  const actual = visibleElements('[class*="actual-credits"]');
  if (actual.length) return actual.sort((a, b) => a.children.length - b.children.length).at(0);
  if (!expectPerImage) return null;
  const candidates = visibleElements("body *").filter((element) => {
    const text = normalize(element.textContent);
    return /^\d+(?:\.\d+)?\s*\/\s*张$/.test(text);
  });
  return candidates.sort((a, b) => a.children.length - b.children.length).at(0) || null;
}

function textElementStartingWith(selector, text) {
  const matches = visibleElements(selector).filter((element) => normalize(element.textContent).startsWith(text));
  return matches.sort((a, b) => a.children.length - b.children.length).at(0) || null;
}

function findRadioByText(text) {
  const normalizedText = normalize(text).toUpperCase();
  const radios = visibleElements('input[type="radio"], [role="radio"]');
  const radio = radios.find((element) => {
    const aria = normalize(element.getAttribute("aria-label")).toUpperCase();
    const parentText = normalize(element.closest("label")?.textContent || element.parentElement?.textContent).toUpperCase();
    return aria === normalizedText || parentText === normalizedText || parentText.includes(normalizedText);
  });
  if (radio) return radio;
  return visibleElements("label, button, div, span").filter((element) => normalize(element.textContent).toUpperCase() === normalizedText).sort((a, b) => a.children.length - b.children.length).at(0) || null;
}

function normalizeResolution(value) {
  const normalized = String(value || "").toUpperCase();
  if (normalized.includes("1.5")) return "1.5K";
  return normalized.includes("4") ? "4K" : "2K";
}

function normalizeVideoResolution(value) {
  const normalized = String(value || "720P").toUpperCase();
  if (normalized.includes("4K")) return "4K";
  if (normalized.includes("1080")) return "1080P";
  if (normalized.includes("480")) return "480P";
  return "720P";
}

function visibleElements(selector) {
  return [...document.querySelectorAll(selector)].filter(isVisible);
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function setNativeInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element) {
  if (!(element instanceof HTMLElement)) throw new Error("即梦报价控件不可点击");
  element.click();
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function waitFor(read, error, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await delay(120);
  }
  throw new Error(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

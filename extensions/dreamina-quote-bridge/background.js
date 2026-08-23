const AGENT_URL = "http://127.0.0.1:17371";
const BRIDGE_VERSION = "0.2.0";
const QUOTE_PAGE = "https://jimeng.jianying.com/ai-tool/generate?workspace=0&type=image&infinite_canvas_quote_bridge=1";
let polling = false;

chrome.runtime.onInstalled.addListener(() => {
  // 解压扩展更新后，已有标签页不会自动注入新版 content script。
  // 主动重载专用报价页，避免继续使用旧版价格映射。
  void reloadSavedQuoteTab();
  void startPolling();
});
chrome.runtime.onStartup.addListener(() => void startPolling());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "dreamina-quote-bridge") void startPolling();
});
chrome.alarms.create("dreamina-quote-bridge", { periodInMinutes: 0.5 });
void startPolling();

async function startPolling() {
  if (polling) return;
  polling = true;
  try {
    const clientId = await getClientId();
    while (true) {
      try {
        const response = await fetch(`${AGENT_URL}/dreamina/web-bridge/poll?clientId=${encodeURIComponent(clientId)}&version=${encodeURIComponent(BRIDGE_VERSION)}&waitMs=20000`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Agent ${response.status}`);
        const payload = await response.json();
        if (payload.task) await handleTask(clientId, payload.task);
      } catch (error) {
        await setStatus({ connected: false, error: error instanceof Error ? error.message : String(error) });
        await delay(1800);
      }
    }
  } finally {
    polling = false;
  }
}

async function handleTask(clientId, task) {
  let result;
  try {
    if (task.kind === "image" && !["5.0", "5.0Pro"].includes(task.modelVersion)) throw new Error(`即梦网页报价桥暂不支持图片 ${task.modelVersion}`);
    if (task.kind === "video" && !["seedance1.0", "seedance1.0fast", "seedance1.5pro", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"].includes(task.modelVersion)) throw new Error(`即梦网页报价桥暂不支持视频 ${task.modelVersion}`);
    if (task.kind !== "image" && task.kind !== "video") throw new Error("即梦网页报价类型无效");
    const tab = await ensureQuoteTab();
    const quote = await sendQuote(tab.id, task);
    const credits = Number(quote.creditsPerUnit) * Number(task.count || 1);
    if (!Number.isInteger(credits) || credits < 0) throw new Error("即梦网页返回了无效积分");
    result = { ok: true, credits };
    await setStatus({ connected: true, lastCredits: credits, lastQuotedAt: Date.now(), error: "" });
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    await setStatus({ connected: true, error: result.error });
  }
  await fetch(`${AGENT_URL}/dreamina/web-bridge/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, requestId: task.requestId, ...result }),
  });
}

async function ensureQuoteTab() {
  const saved = await chrome.storage.local.get("quoteTabId");
  if (saved.quoteTabId) {
    try {
      const tab = await chrome.tabs.get(saved.quoteTabId);
      if (tab.url?.startsWith("https://jimeng.jianying.com/ai-tool/generate")) return tab;
    } catch {}
  }
  const tab = await chrome.tabs.create({ url: QUOTE_PAGE, active: false });
  await chrome.storage.local.set({ quoteTabId: tab.id });
  await waitForTab(tab.id);
  return await chrome.tabs.get(tab.id);
}

async function reloadSavedQuoteTab() {
  const saved = await chrome.storage.local.get("quoteTabId");
  if (!saved.quoteTabId) return;
  try {
    const tab = await chrome.tabs.get(saved.quoteTabId);
    if (!tab.url?.startsWith("https://jimeng.jianying.com/ai-tool/generate")) return;
    await chrome.tabs.reload(tab.id);
    await waitForTab(tab.id);
  } catch {
    await chrome.storage.local.remove("quoteTabId");
  }
}

async function sendQuote(tabId, task) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "dreamina-read-price", task });
      if (response?.ok) return response;
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error ? lastError : new Error("即梦报价页面尚未就绪");
}

async function waitForTab(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    // 即梦存在持续的后台资源请求，页面可交互后标签状态仍可能长期停在 loading。
    // content script 的 sendQuote 重试会继续负责确认生成面板已经就绪。
    if (attempt >= 8 && tab.url?.startsWith("https://jimeng.jianying.com/ai-tool/generate")) return;
    await delay(250);
  }
  throw new Error("即梦报价页面加载超时");
}

async function getClientId() {
  const saved = await chrome.storage.local.get("clientId");
  if (typeof saved.clientId === "string" && saved.clientId.length >= 16) return saved.clientId;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const clientId = `edge_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  await chrome.storage.local.set({ clientId });
  return clientId;
}

async function setStatus(patch) {
  await chrome.storage.local.set({ bridgeStatus: { ...(await chrome.storage.local.get("bridgeStatus")).bridgeStatus, ...patch, updatedAt: Date.now() } });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

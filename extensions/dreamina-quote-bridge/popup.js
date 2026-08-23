async function render() {
  const { bridgeStatus = {} } = await chrome.storage.local.get("bridgeStatus");
  const element = document.getElementById("status");
  if (bridgeStatus.error) {
    element.className = "status error";
    element.textContent = `连接异常：${bridgeStatus.error}`;
    return;
  }
  element.className = "status ok";
  element.textContent = bridgeStatus.connected ? "已连接本地 Agent，可读取官方实时积分" : "正在连接本地 Agent…";
}
void render();

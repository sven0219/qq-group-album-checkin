// 修改这两个字段后，在 chrome://extensions/ 重新加载扩展即可。
// title: 插件面板标题、页面标题和工具栏悬停提示。
// author: 页脚作者姓名/署名；留空 "" 则隐藏作者页脚。
const branding = Object.freeze({
  title: "QQ群相册阅读打卡导出工具",
  author: ""
});

function applyBranding(config) {
  const title = typeof config.title === "string" && config.title.trim()
    ? config.title.trim() : "QQ群相册阅读打卡导出工具";
  const author = typeof config.author === "string" ? config.author.trim() : "";
  document.getElementById("appTitle").textContent = title;
  document.title = title;
  const footer = document.getElementById("appAuthor");
  footer.textContent = author ? `作者：${author}` : "";
  footer.hidden = !author;
  // Chrome 扩展管理页的名称仍由 manifest.json 静态定义。
  chrome.action.setTitle({ title }).catch(() => {});
}

applyBranding(branding);

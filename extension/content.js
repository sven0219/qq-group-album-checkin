const pending = new Map();
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const value = event.data;
  if (value?.source !== 'qq-checkin-page-v2' || !pending.has(value.id)) return;
  const { resolve, timer } = pending.get(value.id);
  clearTimeout(timer); pending.delete(value.id); resolve(value.result);
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'PING') { respond({ ok: true, version: 2 }); return; }
  if (!['READ_ALBUMS', 'READ_MEDIA'].includes(message.type)) return;
  const id = crypto.randomUUID();
  new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'QQ 数据读取超时，请刷新群相册网页后重试。' }); }, 120000);
    pending.set(id, { resolve, timer });
    window.postMessage({ source: 'qq-checkin-extension-v2', id, type: message.type, albumId: message.albumId }, location.origin);
  }).then(respond);
  return true;
});

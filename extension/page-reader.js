// Read QQ's existing metadata methods, not the album creation date in the header.
(() => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function request(invoke) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('QQ 相册接口响应超时')), 15000);
      try { invoke((data) => { clearTimeout(timer); resolve(data); }, (error) => {
        clearTimeout(timer); reject(new Error(error?.message || `QQ 读取失败（${error?.code ?? '未知错误'}）`));
      }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  async function reader() {
    for (let i = 0; i < 40; i++) {
      if (window.seajs?.use && window.GroupZone?.GPHOTO?.groupId) break;
      if (i === 39) throw new Error('QQ 群相册尚未初始化，请确认登录并刷新页面。');
      await delay(250);
    }
    return request((resolve) => window.seajs.use('photo.v7/module/groupPhoto/util/index', resolve));
  }
  async function albums(util) {
    const result = new Map();
    const config = window.GroupZone.GPHOTO;
    const oldCursor = config.albumList?.attach_info;
    let offset = 0, cursor = '';
    try {
      for (let page = 0; page < 200; page++) {
        if (config.albumList) config.albumList.attach_info = cursor;
        const data = await request((ok, fail) => util.logic.getAlbumList(ok, fail, page === 0, offset, 100, 1));
        if (!Array.isArray(data.album)) throw new Error('QQ 未返回相册列表');
        const before = result.size;
        for (const album of data.album) result.set(album.id, { id: album.id, name: album.title, count: Number(album.photocnt) });
        const next = Number(data.offset ?? offset + data.album.length);
        const total = Number(data.total);
        if (!data.album.length && Number.isFinite(total) && next < total) throw new Error('相册分页返回空页，目录未读取完整');
        if (!data.album.length || data.hasmore === false || data.hasmore === 0 || (Number.isFinite(total) && next >= total)) return { albums: [...result.values()], complete: true };
        if (before === result.size || next <= offset) throw new Error('QQ 相册分页没有前进，列表未读取完整');
        cursor = data.attach_info || ''; offset = next;
      }
      throw new Error('QQ 相册页数超出限制');
    } finally { if (config.albumList) config.albumList.attach_info = oldCursor; }
  }
  async function media(util, albumId) {
    const result = new Map();
    let offset = 0, cursor = '', total;
    for (let page = 0; page < 200; page++) {
      const data = await request((ok, fail) => util.logic.getPhotoList(albumId, null, { start: offset, num: 100, getalbum: page === 0 ? 1 : 0, attach_info: cursor }, ok, fail));
      const rows = data.photos || data.photo;
      if (!Array.isArray(rows)) throw new Error('QQ 未返回媒体列表');
      const pageTotal = Number(data.total ?? data.album?.photocnt);
      if (Number.isFinite(pageTotal) && pageTotal > 0) total = pageTotal;
      const before = result.size;
      for (const row of rows) {
        const id = row.id || row.lloc;
        const uploadtime = row.uploadtime ?? row.uUploadTime;
        if (!id || !uploadtime) throw new Error('媒体记录缺少上传时间，无法统计');
        result.set(id, { id, uploadtime });
      }
      offset += rows.length;
      if (data.hasmore === false || data.hasmore === 0 || (data.hasmore !== true && data.hasmore !== 1 && Number.isFinite(total) && result.size >= total) || (!rows.length && (!Number.isFinite(total) || result.size >= total))) {
        if (Number.isFinite(total) && result.size < total) throw new Error(`媒体读取不完整：${result.size}/${total}`);
        return { media: [...result.values()], total: result.size, complete: true };
      }
      if (!rows.length || before === result.size) throw new Error(`媒体分页未完成：${result.size}/${total || '?'}`);
      cursor = data.attach_info || '';
    }
    throw new Error('QQ 媒体页数超出限制');
  }
  window.addEventListener('message', async (event) => {
    const msg = event.data;
    if (event.source !== window || event.origin !== location.origin || msg?.source !== 'qq-checkin-extension-v2') return;
    if (!['READ_ALBUMS', 'READ_MEDIA'].includes(msg.type)) return;
    let result;
    try {
      const util = await reader();
      result = { ok: true, ...(msg.type === 'READ_ALBUMS' ? await albums(util) : await media(util, String(msg.albumId))) };
    } catch (error) { result = { ok: false, error: error.message }; }
    window.postMessage({ source: 'qq-checkin-page-v2', id: msg.id, result }, location.origin);
  });
})();

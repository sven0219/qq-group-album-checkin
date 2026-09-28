import { makeWorkbook } from "./xlsx.js";

const key = "qqCheckinStateV1";
// Shared distribution has no embedded group identifiers or children's names.
const initial = { term: "", semesterStartDate: "", className: "", groupId: "", roster: [], records: [], lastScanAt: "", lastNoVisibleAlbums: [], albumStatus: {}, dataVersion: 2 };
async function state() {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  const result = { ...initial, ...value };
  result.className = value?.className || value?.roster?.[0]?.className || initial.className;
  result.roster = result.roster.map(row => ({ studentNo: row.studentNo, name: row.name, albumName: row.albumName || row.name }));
  // V1 counted album-creation dates; retain those separately but do not export them.
  if (value && value.dataVersion !== 2) {
    result.legacyRecords = value.records;
    result.records = []; result.lastScanAt = ""; result.albumStatus = {};
  }
  return result;
}
async function save(next) { await chrome.storage.local.set({ [key]: next }); return next; }
async function send(tabId, message) { return chrome.tabs.sendMessage(tabId, message); }
let scanning = false;
let exporting = false;
const operationKey = "qqCheckinOperation";
async function reportOperation(value) {
  await chrome.storage.local.set({ [operationKey]: value });
  await chrome.runtime.sendMessage({ type: "OPERATION", operation: value }).catch(() => {});
}
function albumUrl(groupId) { return `https://h5.qzone.qq.com/groupphoto/index?inqq=1&groupId=${encodeURIComponent(groupId)}`; }
async function openLogin(tabId, groupId) {
  await chrome.tabs.update(tabId, { url: `https://i.qq.com/?s_url=${encodeURIComponent(albumUrl(groupId))}`, active: true });
  const error = new Error("请在 QQ 官方登录页完成登录，再点击导出。登录成功后会返回对应群相册。");
  error.needsLogin = true; throw error;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function isAlbumPage(tab, groupId) {
  try { const url = new URL(tab.url); return url.origin === "https://h5.qzone.qq.com" && url.pathname.startsWith("/groupphoto/") && url.searchParams.get("groupId") === groupId; }
  catch { return false; }
}
async function ensureAlbumPage(groupId, refresh = false) {
  if (!/^\d{5,12}$/.test(groupId)) throw new Error("请输入有效的 QQ 群号");
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = active;
  if (!isAlbumPage(tab, groupId)) {
    const tabs = await chrome.tabs.query({ currentWindow: true, url: "https://h5.qzone.qq.com/groupphoto/*" });
    tab = tabs.find(candidate => isAlbumPage(candidate, groupId));
    if (tab) tab = await chrome.tabs.update(tab.id, { active: true });
    else tab = await chrome.tabs.create({ url: albumUrl(groupId), active: true });
  }
  if (refresh && isAlbumPage(tab, groupId)) { await chrome.tabs.reload(tab.id, { bypassCache: true }); await delay(250); }
  for (let attempt = 0; attempt < 120; attempt++) {
    const fresh = await chrome.tabs.get(tab.id);
    if (fresh.status === "complete") {
      if (!isAlbumPage(fresh, groupId)) {
        if (/^https:\/\/(i\.qq\.com|(?:[^/]+\.)?ptlogin2\.qq\.com)(?:[/?]|$)/.test(fresh.url)) throw new Error("请在 QQ 官方登录页完成登录，再点击导出。登录后会返回对应群相册。");
        return openLogin(tab.id, groupId);
      }
      try { const ping = await send(tab.id, { type: "PING" }); if (ping.version === 2) return fresh; }
      catch { /* Content scripts may not yet be injected. */ }
    }
    await delay(500);
  }
  throw new Error("群相册未准备好，请确认 QQ 已登录，并刷新页面后重试");
}
function uploadDate(value) {
  const number = Number(value);
  let d;
  if (Number.isFinite(number) && number > 0) d = new Date(number < 1e12 ? number * 1000 : number);
  else {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/);
    if (!match) throw new Error("上传时间格式无法识别");
    d = new Date(match[1] + "-" + match[2] + "-" + match[3] + "T" + (match[4] || "00") + ":" + (match[5] || "00") + ":" + (match[6] || "00") + "+08:00");
  }
  if (!Number.isFinite(d.getTime())) throw new Error("上传时间无效");
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
async function scanAll(onProgress = () => {}) {
  if (scanning) throw new Error("扫描正在进行，请等候完成");
  scanning = true;
  try {
    const current = await state();
    let active = await ensureAlbumPage(current.groupId, true);
    let index = await send(active.id, { type: "READ_ALBUMS" });
    if (!index.ok) {
      // A fresh navigation lets QQ's server redirect an expired session to its login page.
      await chrome.tabs.update(active.id, { url: albumUrl(current.groupId) });
      active = await ensureAlbumPage(current.groupId);
      index = await send(active.id, { type: "READ_ALBUMS" });
    }
    if (!index.ok || !index.complete) throw new Error(index.error || "相册目录读取不完整");
    const catalog = new Map(index.albums.map(album => [album.name.trim(), album]));
    const noVisibleAlbums = [], errors = [];
    let scanned = 0;
    current.albumStatus = {};
    current.dataVersion = 2;
    for (let i = 0; i < current.roster.length; i++) {
      const child = current.roster[i];
      await onProgress({ current: i + 1, total: current.roster.length, name: child.name });
      const album = catalog.get(child.albumName.trim());
      const scannedAt = new Date().toISOString();
      if (!album || album.count === 0) {
        noVisibleAlbums.push(child.name);
        current.records = current.records.filter(row => row.name !== child.name);
        current.albumStatus[child.name] = { status: "empty", scannedAt, reason: "完整目录中未显示相册或媒体数为0；按未打卡处理，请确认相册名" };
      } else {
        try {
          const result = await send(active.id, { type: "READ_MEDIA", albumId: album.id });
          if (!result.ok && /登录|登陆|login/i.test(result.error || "")) return await openLogin(active.id, current.groupId);
          if (!result.ok || !result.complete) throw new Error(result.error || "媒体读取不完整");
          const daily = new Map();
          for (const media of result.media) {
            const date = uploadDate(media.uploadtime);
            daily.set(date, (daily.get(date) || 0) + 1);
          }
          current.records = current.records.filter(row => row.name !== child.name);
          for (const [date, mediaCount] of daily) current.records.push({ name: child.name, date, albumName: child.albumName, mediaCount, scannedAt });
          current.albumStatus[child.name] = { status: "ok", scannedAt, mediaCount: result.total };
          scanned += daily.size;
        } catch (error) {
          if (error.needsLogin) throw error;
          errors.push(child.name + "：" + error.message);
          current.albumStatus[child.name] = { status: "error", reason: error.message, scannedAt };
        }
      }
      // Checkpoint each child so a failed request or closed popup loses no progress.
      await save({ ...current, lastNoVisibleAlbums: noVisibleAlbums });
    }
    current.lastScanAt = new Date().toISOString();
    current.lastNoVisibleAlbums = noVisibleAlbums;
    current.lastErrors = errors;
    await save(current);
    return { scanned, noVisibleAlbums, errors };
  } finally { scanning = false; }
}
function monday(value) { const d = new Date(`${value}T12:00:00`); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
function toIso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function firstWeek(current) { validateDate(current.semesterStartDate); return monday(current.semesterStartDate); }
function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || !Number.isFinite(new Date(value+'T12:00:00').getTime()) || toIso(new Date(value+'T12:00:00')) !== value) throw new Error("请选择有效日期");
}
function weekNumber(current, value) { validateDate(value); return Math.round((monday(value)-firstWeek(current))/604800000)+1; }
function dateRange(current, startDate, endDate) {
  validateDate(startDate); validateDate(endDate);
  if (startDate > endDate) throw new Error("结束日期不能早于开始日期");
  const from=weekNumber(current,startDate), to=weekNumber(current,endDate);
  if (from < 1) throw new Error("开始日期所在周早于学期第1周，请检查学期开始日期");
  validateRange(from,to); return {from,to};
}
function weeklyRows(current, weekStart) {
  const startOfSemester = firstWeek(current);
  const recordsByDay = new Set(current.records.map((row) => `${row.name}|${row.date}`));
  const weekNo = Math.round((weekStart - startOfSemester) / 604800000) + 1;
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return toIso(d); });
  const serial = value => Math.round((Date.parse(value + "T00:00:00Z") - Date.UTC(1899,11,30)) / 86400000);
  const rows = [[], [`${current.term} ${current.className} 第${weekNo}周打卡记录`], [`日期：${days[0]} 至 ${days[6]}`], [], ["学号", "姓名", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "打卡天数"], ["", "", ...days.map(serial), ""]];
  for (const child of current.roster) {
    const checked = ["ok", "empty"].includes(current.albumStatus?.[child.name]?.status);
    const marks = days.map((date) => checked ? (recordsByDay.has(`${child.name}|${date}`) ? "√" : "") : "未核实");
    const r = rows.length + 1;
    rows.push([child.studentNo, child.name, ...marks, { formula: `IF(COUNTIFS(C${r}:I${r},"未核实")>0,"未核实",COUNTIFS(C${r}:I${r},"√"))`, value: checked ? marks.filter(Boolean).length : "未核实" }]);
  }
  return { name: `第${weekNo}周`, rows, days, weekly: true };
}
function validateRange(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 100) throw new Error("请输入有效周范围（1 至 100，结束周不能早于开始周）");
}
function historySheet(current, start, end) {
  const children = new Map(current.roster.map(child => [child.name, child]));
  const records = current.records.filter(row => children.has(row.name) && row.date >= start && row.date <= end).sort((a,b) => children.get(a.name).studentNo - children.get(b.name).studentNo || a.date.localeCompare(b.date));
  const serial = value => (Date.parse(value + "T00:00:00Z") - Date.UTC(1899,11,30)) / 86400000;
  const status = name => current.albumStatus?.[name]?.status === "ok" ? "已核实" : "未核实";
  return { name: "历史明细", kind: "history", rows: [["学号", "姓名", "上传日期", "来源相册", "媒体数量", "采集时间（北京时间）", "本次读取状态"], ...records.map(row => [children.get(row.name).studentNo, row.name, serial(row.date), row.albumName, row.mediaCount || "", row.scannedAt ? (Date.parse(row.scannedAt) + 8*3600000 - Date.UTC(1899,11,30)) / 86400000 : "", status(row.name)])] };
}
function auditSheet(current, range) {
  const start=firstWeek(current), end=new Date(start);end.setDate(end.getDate()+6);
  return { name: "统计说明", kind: "audit", rows: [["项目", "内容"], ["QQ群号", current.groupId], ["导出范围", range], ["扫描结束时间", current.lastScanAt ? new Date(Date.parse(current.lastScanAt)+8*3600000).toISOString().replace('T',' ').slice(0,19)+"（北京时间）" : "尚未扫描"], ["统计规则", "图片或视频上传当天计打卡；同一孩子同一天多次上传只计1天。"], ["日期依据", "媒体上传时间（北京时间），不是相册创建时间；补传按上传当天计算。"], ["周次口径", `周一至周日；学期开始日期为${current.semesterStartDate}，第1周为${toIso(start)}至${toIso(end)}。`], ["名单人数", current.roster.length], ["零媒体/目录未显示相册", current.lastNoVisibleAlbums?.join("、") || "无"], ["缺失相册处理", "完整目录未显示或零媒体相册按未打卡处理，请确认相册名没有错别字。"], ["读取失败处理", "自动导出遇到读取失败时停止下载，避免把未知状态计成0天。"], ["历史明细范围", "只包含本次导出周范围内的记录。"], ...current.roster.map(child => { const result=current.albumStatus?.[child.name]; return [child.name, result?.status === "ok" ? "已核实" : result?.status === "empty" ? "未显示/零媒体相册，按未打卡处理" : "未核实："+(result?.reason || "尚未读取")]; })] };
}
function exportWorkbook(current, from, to) {
  validateRange(from, to);
  const startOfSemester = firstWeek(current);
  const weeklySheets = [];
  for (let week = from; week <= to; week++) { const start = new Date(startOfSemester); start.setDate(start.getDate() + (week - 1) * 7); weeklySheets.push(weeklyRows(current, start)); }
  return makeWorkbook([...weeklySheets, historySheet(current, weeklySheets[0].days[0], weeklySheets.at(-1).days[6]), auditSheet(current, `第${from}周至第${to}周`)]);
}
function exportOneWeek(current, dateInWeek) {
  validateWeekDate(current,dateInWeek);
  const week = weeklyRows(current, monday(dateInWeek));
  return { bytes: makeWorkbook([week, historySheet(current, week.days[0], week.days[6]), auditSheet(current, week.name)]), weekName: week.name, dateRange: `${week.days[0]} 至 ${week.days[6]}` };
}
function validateWeekDate(current,value) {
  const week = weekNumber(current,value);
  if (week < 1) throw new Error("所选日期所在周早于学期第1周，请检查学期开始日期");
  validateRange(week, week);
}
function exportPreviousWeek(current) {
  const today = new Date();
  return exportOneWeek(current, toIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)));
}
async function downloadBytes(bytes, filename) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const url = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${btoa(binary)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
}
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  (async () => {
    if (message.type === "GET_STATE") {
      let operation = (await chrome.storage.local.get(operationKey))[operationKey];
      if (operation?.status === "running" && !exporting) operation = { status: "error", text: "上次任务中断，请重新点击导出" };
      return { ok: true, data: { ...await state(), operation } };
    }
    if (message.type === "SAVE_SETTINGS") {
      if (scanning || exporting) throw new Error("请在导出结束后修改设置");
      validateDate(message.data.semesterStartDate);
      const old = await state(), next = { ...old, term: message.data.term, semesterStartDate: message.data.semesterStartDate, className: message.data.className, groupId: message.data.groupId, roster: message.data.roster, dataVersion: 2 };
      if (next.groupId !== old.groupId) { next.records = []; next.albumStatus = {}; next.lastScanAt = ""; next.lastNoVisibleAlbums = []; }
      else for (const child of next.roster) {
        if (!old.roster.some(row => row.name === child.name && row.albumName === child.albumName)) {
          delete next.albumStatus[child.name];
          next.records = next.records.filter(row => row.name !== child.name);
        }
      }
      return { ok: true, data: await save(next) };
    }
    if (["EXPORT_PREVIOUS_WEEK", "EXPORT_SELECTED_WEEK", "EXPORT_RANGE"].includes(message.type)) {
      if (exporting || scanning) throw new Error("已有导出任务正在进行");
      const configuration=await state();
      const range=message.type === "EXPORT_RANGE" ? dateRange(configuration,message.startDate,message.endDate) : null;
      if (message.type === "EXPORT_SELECTED_WEEK") validateWeekDate(configuration,message.weekStart);
      if (message.type === "EXPORT_PREVIOUS_WEEK") { const now=new Date();now.setDate(now.getDate()-7);validateWeekDate(configuration,toIso(now)); }
      exporting = true;
      try {
        await reportOperation({ status: "running", text: "正在打开并刷新群相册，检查登录…" });
        const scan = await scanAll(progress => reportOperation({ status: "running", text: `正在扫描 ${progress.current}/${progress.total}：${progress.name}`, progress }));
        if (scan.errors.length) throw new Error(`以下孩子读取失败，未导出文件，请重试：\n${scan.errors.join("\n")}`);
        const data = await state();
        const result = message.type === "EXPORT_RANGE" ? { bytes: exportWorkbook(data, range.from, range.to), weekName: `第${range.from}周至第${range.to}周` } : message.type === "EXPORT_SELECTED_WEEK" ? exportOneWeek(data, message.weekStart) : exportPreviousWeek(data);
        if (range) {
          const start=firstWeek(data), end=firstWeek(data);
          start.setDate(start.getDate()+(range.from-1)*7);end.setDate(end.getDate()+(range.to-1)*7+6);
          result.dateRange=`${toIso(start)} 至 ${toIso(end)}`;
        }
        await reportOperation({ status: "running", text: "扫描完成，正在生成 Excel…" });
        const filename = `${data.term}_${data.className}_${result.weekName}打卡记录.xlsx`.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
        await downloadBytes(result.bytes, filename);
        await reportOperation({ status: "done", text: `${result.weekName}（${result.dateRange}）\n已开始下载（已自动扫描）。`, noVisibleAlbums: scan.noVisibleAlbums });
        return { ok: true, weekName: result.weekName, dateRange: result.dateRange };
      } catch (error) { await reportOperation({ status: "error", text: error.message }); throw error; }
      finally { exporting = false; }
    }
    throw new Error("未知请求");
  })().then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

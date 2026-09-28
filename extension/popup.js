const $ = id => document.getElementById(id);
let busy = false;
let saveNoticeTimer;
function iso(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function mondayDate(value) { const d=new Date(value+'T12:00:00'); const day=d.getDay()||7;d.setDate(d.getDate()-day+1);return d; }
function weekInfo(value) {
  if (!value || !$('semesterStartDate').value) return null;
  const start=mondayDate(value),end=new Date(start);end.setDate(end.getDate()+6);
  return {number:Math.round((start-mondayDate($('semesterStartDate').value))/604800000)+1,start:iso(start),end:iso(end)};
}
function updateHints() {
  const first=weekInfo($('semesterStartDate').value), selected=weekInfo($('weekStart').value), from=weekInfo($('rangeStartDate').value), to=weekInfo($('rangeEndDate').value);
  $('firstWeekHint').textContent=first?`第 1 周：${first.start} 至 ${first.end}`:'请选择学期开始日期';
  $('selectedHint').textContent=selected?selected.number<1?'该日期早于当前学期，请检查学期开始日期':`第 ${selected.number} 周：${selected.start} 至 ${selected.end}`:'';
  $('rangeHint').textContent=from&&to?from.number<1||to.number<from.number||$('rangeStartDate').value>$('rangeEndDate').value?'请检查日期范围与学期开始日期':`第 ${from.number} 周至第 ${to.number} 周（${from.start} 至 ${to.end}）`:'';
}
const buttons = ['save','exportSelected','exportPrevious','exportRange'];
function show(operation) {
  busy = operation.status === 'running';
  buttons.forEach(id => { $(id).disabled = busy; });
  $('status').textContent = operation.text;
  $('statusBox').dataset.state = operation.status;
  $('progress').hidden = !busy;
  if (operation.progress) { $('progress').max = operation.progress.total; $('progress').value = operation.progress.current; }
  else $('progress').removeAttribute('value');
  $('emptyNotice').hidden = !operation.noVisibleAlbums?.length;
  $('emptyNotice').textContent = operation.noVisibleAlbums?.length ? '目录未显示或零媒体（按未打卡处理，请确认相册名）：'+operation.noVisibleAlbums.join('、') : '';
  if (operation.status !== 'idle') $('statusBox').scrollIntoView({block:'nearest'});
}
async function call(message) { const reply = await chrome.runtime.sendMessage(message); if (!reply?.ok) throw new Error(reply?.error || '插件后台未响应，请重新打开面板'); return reply; }
function parseRoster(text) {
  const rows = text.split(/\n/).filter(line => line.trim()).map(line => line.split(/[,，]/).map(v => v.trim()));
  if (!rows.length || rows.some(row => row.length < 2 || row.length > 3 || !row[1] || !/^\d+$/.test(row[0]))) throw new Error('名单格式：学号,姓名,相册名，每行一位');
  if (new Set(rows.map(row => row[1])).size !== rows.length || new Set(rows.map(row => Number(row[0]))).size !== rows.length) throw new Error('姓名或学号重复，请检查儿童名单');
  return rows.map(([studentNo,name,albumName]) => ({studentNo:Number(studentNo),name,albumName:albumName || name}));
}
async function saveSettings() {
  const groupId = $('groupId').value.trim(), term = $('term').value.trim(), className = $('className').value.trim(), semesterStartDate = $('semesterStartDate').value, roster = parseRoster($('roster').value);
  if (!/^\d{5,12}$/.test(groupId)) throw new Error('请输入有效的QQ群号');
  if (!term) throw new Error('请输入学期名称');
  if (!className) throw new Error('请输入班级名称');
  if (!semesterStartDate) throw new Error('请选择学期开始日期');
  await call({type:'SAVE_SETTINGS',data:{groupId,term,className,semesterStartDate,roster}});
  $('rosterCount').textContent = `${roster.length} 位孩子`;
}
async function run(message) {
  if (busy) return;
  try {
    show({status:'running',text:'正在准备自动刷新、扫描与导出…'});
    await saveSettings();
    const reply = await call(message);
    // The final OPERATION message includes zero-media notices; preserve it.
    if (busy) show({status:'done',text:`${reply.weekName}（${reply.dateRange}）\n已开始下载。`});
  } catch (error) { show({status:'error',text:error.message}); }
}
$('save').onclick = async () => {
  if (busy) return;
  clearTimeout(saveNoticeTimer);
  try {
    show({status:'running',text:'正在保存设置…'});
    $('save').textContent='正在保存…';
    await saveSettings();
    show({status:'saved',text:'✓ 设置保存成功\n班级、学期、群号和儿童名单已更新。'});
    $('save').textContent='✓ 已保存';
    $('save').dataset.saved='true';
    saveNoticeTimer=setTimeout(() => { $('save').textContent='保存设置'; delete $('save').dataset.saved; },3000);
  } catch(error) {
    $('save').textContent='保存设置'; delete $('save').dataset.saved;
    show({status:'error',text:error.message});
  }
};
$('exportSelected').onclick = () => {
  if (!$('weekStart').value) return show({status:'error',text:'请选择指定周中的任意一天'});
  run({type:'EXPORT_SELECTED_WEEK',weekStart:$('weekStart').value});
};
$('exportPrevious').onclick = () => run({type:'EXPORT_PREVIOUS_WEEK'});
$('exportRange').onclick = () => {
  const startDate=$('rangeStartDate').value,endDate=$('rangeEndDate').value;
  if (!startDate || !endDate || startDate>endDate) return show({status:'error',text:'请选择有效日期范围，结束日期不能早于开始日期'});
  run({type:'EXPORT_RANGE',startDate,endDate});
};
['semesterStartDate','weekStart','rangeStartDate','rangeEndDate'].forEach(id=>{ $(id).onchange=updateHints; });
chrome.runtime.onMessage.addListener(message => { if (message.type === 'OPERATION') show(message.operation); });
async function init() {
  try {
    const {data} = await call({type:'GET_STATE'});
    $('term').value=data.term; $('className').value=data.className; $('groupId').value=data.groupId;
    $('semesterStartDate').value=data.semesterStartDate;
    $('roster').value=data.roster.map(row => [row.studentNo,row.name,row.albumName].join(',')).join('\n');
    $('rosterCount').textContent=`${data.roster.length} 位孩子`;
    const today=iso(new Date()); $('weekStart').value=today;
    $('rangeStartDate').value=data.semesterStartDate; $('rangeEndDate').value=today>=data.semesterStartDate?today:data.semesterStartDate;
    updateHints();
    show(data.operation || {status:'idle',text:'准备就绪。导出时自动打开群相册、检查登录并扫描。'});
  } catch(error) { show({status:'error',text:error.message}); }
}
init();

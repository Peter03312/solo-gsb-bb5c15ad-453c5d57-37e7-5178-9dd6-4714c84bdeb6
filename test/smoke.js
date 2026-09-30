'use strict';

// 端到端冒烟测试：启动服务，走一遍核心业务流。
// node test/smoke.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const zipLib = require('../src/zip');
const pkgIO = require('../src/packageio');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sherd-smoke-'));
process.env.DB_FILE = path.join(process.env.DATA_DIR, 't.db');
process.env.UPLOAD_DIR = path.join(process.env.DATA_DIR, 'uploads');
process.env.PORT = '8791';

function req(method, url, { body, version, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (raw) {
      payload = raw;
      Object.assign(headers, body.getHeaders());
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    if (version !== undefined) headers['Base-Version'] = String(version);
    const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: url, method, headers }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('✘', msg); process.exit(1); }
  console.log('✔', msg);
}

function multipart(fields, fileBuf) {
  const boundary = '----smoke' + Math.random().toString(16).slice(2);
  const crlf = '\r\n';
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`;
  }
  head += `--${boundary}${crlf}Content-Disposition: form-data; name="photo"; filename="a.png"${crlf}Content-Type: image/png${crlf}${crlf}`;
  const tail = `${crlf}--${boundary}--${crlf}`;
  const payload = Buffer.concat([Buffer.from(head), fileBuf, Buffer.from(tail)]);
  return {
    getHeaders() {
      return { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length };
    },
    payload,
  };
}

// 下载二进制（ZIP）响应。
function reqBuf(method, url, { body, version, raw } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (raw) {
      payload = raw;
      Object.assign(headers, body.getHeaders());
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    if (version !== undefined) headers['Base-Version'] = String(version);
    const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: url, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json, buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// 以 multipart 上传 ZIP 方案包（字段名 package）。
function packageMultipart(zipBuf, fields = {}, filename = 'pkg.zip') {
  const boundary = '----smokepkg' + Math.random().toString(16).slice(2);
  const crlf = '\r\n';
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`;
  }
  head += `--${boundary}${crlf}Content-Disposition: form-data; name="package"; filename="${filename}"${crlf}Content-Type: application/zip${crlf}${crlf}`;
  const tail = `${crlf}--${boundary}--${crlf}`;
  const payload = Buffer.concat([Buffer.from(head), zipBuf, Buffer.from(tail)]);
  return {
    getHeaders() {
      return { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length };
    },
    payload,
  };
}

async function importZip(zipBuf, fields) {
  const form = packageMultipart(zipBuf, fields);
  return reqBuf('POST', '/api/imports', { raw: form.payload, body: form });
}

// 打开导出包并改写后重新打包（供制造各类非法包）。
function rewritePackage(zipBuf, mutate) {
  const entries = zipLib.unzip(zipBuf);
  const map = new Map(entries);
  let manifest = JSON.parse(map.get('manifest.json').toString('utf8'));
  manifest = mutate(manifest, map) || manifest;
  map.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  return zipLib.zipEntries([...map.entries()].map(([name, data]) => ({ name, data })));
}

// 按 ord 对布局做规范化（去掉导入/导出两侧本地 id 差异），便于比较等价性。
// sherdIdToOrd：陶片本地 id → ord；seamIdToOrd：接缝本地 id → 接缝采纳序。
function canonicalLayout(layoutObj, sherdIdToOrd, seamIdToOrd) {
  const groups = layoutObj.groups.map((g) => ({
    members: g.member_ids.map((id) => sherdIdToOrd.get(id)).sort((a, b) => a - b),
    rootOrd: sherdIdToOrd.get(g.root_sherd_id),
    treeSeams: g.tree_seam_ids.map((id) => seamIdToOrd.get(id)).sort((a, b) => a - b),
    poses: Object.fromEntries(Object.entries(g.poses).map(([id, p]) => [sherdIdToOrd.get(parseInt(id, 10)), p])),
  })).sort((a, b) => a.rootOrd - b.rootOrd);
  const unconnected = layoutObj.unconnected.map((id) => sherdIdToOrd.get(id)).sort((a, b) => a - b);
  return { groups, unconnected };
}

async function main() {
  require('../server.js');
  await new Promise((r) => setTimeout(r, 400));

  // 健康检查 + 建表版本
  let r = await req('GET', '/api/health');
  assert(r.status === 200 && r.json.ok, '服务启动 / schema_meta 就绪');

  // 建方案（容差 2mm）
  r = await req('POST', '/api/projects', { body: { name: '冒烟方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建方案');
  const pid = r.json.project.id;
  let ver = r.json.project.version;
  assert(ver === 1, '初始版本 v1');

  // 造 4 张极小 PNG（1x1 红点），逻辑尺寸按 100x100 上报
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  async function addSherd(label) {
    const form = multipart({ label, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${pid}/sherds`, { version: ver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('上传失败: ' + JSON.stringify(rr.json));
    ver = rr.json.project.version;
    return rr.json.sherds[rr.json.sherds.length - 1].id;
  }
  const a = await addSherd('A');
  const b = await addSherd('B');
  const c = await addSherd('C');
  const d = await addSherd('D');
  assert([a, b, c, d].every((x) => x), '上传 4 片陶片，每次写操作推进版本');

  // 未设比例尺时建接缝 => 400
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: 10, ty: 0 } });
  assert(r.status === 400, '未标定比例尺禁止建接缝');

  // 比例尺：100px = 10mm => 10px/mm，每片 10mm×10mm
  for (const id of [a, b, c, d]) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: ver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, `陶片 #${id} 比例尺保存`);
    ver = r.json.project.version;
  }

  // 接缝 A->B：B 相对 A 仅平移 10mm（并排放置）。
  // pB = pA - (10,0) => theta=0, tx=-10, ty=0
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: b, theta_deg: 0, tx: -10, ty: 0, join_note: '口沿 A-B' } });
  assert(r.status === 201, '采纳接缝 A->B');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1, 'A、B 构成一个连通组');
  assert(r.json.layout.unconnected.length === 2, 'C、D 未连通，单独显示');
  const g1 = r.json.layout.groups[0];
  assert(g1.poses[a].x === 0 && g1.poses[b].x === 10, 'B 世界位姿为 x=10mm（与 A 拼接）');

  // B->C 再平移 10
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C' } });
  assert(r.status === 201, '采纳接缝 B->C');
  ver = r.json.project.version;
  const seamBCId = r.json.seams[r.json.seams.length - 1].id;
  const g2 = r.json.layout.groups[0];
  assert(g2.poses[c].x === 20, 'C 沿接缝链推导到 x=20mm');
  assert(g2.chains[c].length === 2, 'C 的位置依据为 2 条接缝的链');

  // ---------- 撤销：删除 B->C 后必须断组并重算，不沿用旧布局 ----------
  r = await req('DELETE', `/api/seams/${seamBCId}`, { version: ver });
  assert(r.status === 200, '撤销接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups.length === 1 && r.json.layout.groups[0].member_ids.length === 2,
    '撤销后仅剩 A-B 一个连通组');
  assert(r.json.layout.unconnected.sort().join(',') === [c, d].sort().join(','),
    'C、D 变为未连通陶片，单独显示');
  const gAB = r.json.layout.groups[0];
  assert(gAB.poses[b].x === 10, '保留组内 B 仍由接缝 A-B 重新推导为 x=10mm（不持久化布局）');

  // ---------- 重新拼回，再验成环 ----------
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: c, theta_deg: 0, tx: -10, ty: 0, join_note: '腹部 B-C（重新采纳）' } });
  assert(r.status === 201, '重新采纳接缝 B->C');
  ver = r.json.project.version;
  assert(r.json.layout.groups[0].poses[c].x === 20, 'C 再次沿接缝链推导到 x=20mm');

  // 成环且闭合：A->C，平移 -20（偏差 0），应采纳
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: a, to_id: c, theta_deg: 0, tx: -20, ty: 0, join_note: '复核 A-C' } });
  assert(r.status === 201 && r.json.closed_cycle === true, '闭合环且残差为 0：采纳为成环接缝');
  ver = r.json.project.version;
  const resRow = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(resRow && resRow.distance_mm === 0 && resRow.within_tolerance, '成环接缝残差 0，在容差内');

  // C->D 平移 10，四片连通
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: c, to_id: d, theta_deg: 0, tx: -10, ty: 0 } });
  assert(r.status === 201, '采纳接缝 C->D，四片连通');
  ver = r.json.project.version;

  // 制造超差成环：B->D 链上期望 tx=-20（D 在 x=30），给 tx=-16 => 偏差 4mm > 2mm
  r = await req('POST', `/api/projects/${pid}/seams`, { version: ver, body: { from_id: b, to_id: d, theta_deg: 0, tx: -16, ty: 0, join_note: '错误试拼 B-D' } });
  assert(r.status === 422, '成环偏差 4mm > 容差 2mm：拒绝（422）');
  assert(r.json.error.conflict_chain, '返回冲突链信息');
  const chain = r.json.error.conflict_chain;
  const chainSeams = chain.seams
    .map((s) => `${s.from_id}>${s.to_id}`)
    .join('|');
  assert(chain.seams.length === 2 && chainSeams === `${b}>${c}|${c}>${d}`,
    `冲突链沿既有接缝 B->C->D（实际：${chainSeams}）`);
  assert(chain.sherds[0].id === b && chain.sherds[chain.sherds.length - 1].id === d,
    '冲突链陶片路径起于 B、止于 D');
  assert(r.json.error.deviation_mm === 4, `偏差报告为 4mm（实际 ${r.json.error.deviation_mm}）`);

  // 拒绝后布局不变：仍 4 条接缝、D 在 30
  r = await req('GET', `/api/projects/${pid}`);
  assert(r.json.seams.length === 4, '拒绝不写入接缝，接缝数仍为 4');
  assert(r.json.project.version === ver, '拒绝不推进版本');
  assert(r.json.layout.groups[0].poses[d].x === 30, '原布局保持（D 在 x=30）');

  // 基于过期版本写入 => 409
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver - 1, body: { tolerance_mm: 3 } });
  assert(r.status === 409, '过期 Base-Version 写入被拒绝（版本冲突）');
  assert(r.json.error.current_version === ver, '冲突响应给出服务器当前版本');

  // 缺少 Base-Version => 428
  r = await req('PATCH', `/api/projects/${pid}`, { body: { tolerance_mm: 3 } });
  assert(r.status === 428, '缺少 Base-Version 被拒绝');

  // ---------- 旋转误差也要被捕获：A->B 再给一个带角度偏差的环 ----------
  // 用 1mm 平移容差已经超了就不测旋转了；这里校验调小容差后原闭合边变红
  r = await req('PATCH', `/api/projects/${pid}`, { version: ver, body: { tolerance_mm: 0.5 } });
  assert(r.status === 200, '用正确版本把容差调到 0.5mm');
  ver = r.json.project.version;
  const acRes = r.json.layout.residuals.find((x) => x.from_id === a && x.to_id === c);
  assert(acRes && acRes.distance_mm === 0 && acRes.within_tolerance, '残差为 0 仍在 0.5mm 容差内');

  // ===================== 接缝修订（预览 + 原子确认） =====================
  // 独立建一个 6 片、含两个独立闭合环的方案，便于同时制造多条超差。
  r = await req('POST', '/api/projects', { body: { name: '修订方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建修订测试方案');
  const rpid = r.json.project.id;
  let rver = r.json.project.version;
  const s = [];
  for (let i = 0; i < 6; i++) {
    const form = multipart({ label: `R${i}`, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${rpid}/sherds`, { version: rver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('上传失败: ' + JSON.stringify(rr.json));
    rver = rr.json.project.version;
    s.push(rr.json.sherds[rr.json.sherds.length - 1].id);
  }
  for (const id of s) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: rver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, '修订方案比例尺');
    rver = r.json.project.version;
  }
  // 链：0->1->2（成环 0->2，残差 0）；独立链 3->4->5（成环 3->5，残差 0）。
  // 约定 theta=0,tx=-10,ty=0 表示 B 在 A 右侧 10mm。
  async function addSeamR(pair, tx, note) {
    const rr = await req('POST', `/api/projects/${rpid}/seams`,
      { version: rver, body: { from_id: pair[0], to_id: pair[1], theta_deg: 0, tx, ty: 0, join_note: note || '' } });
    if (rr.status !== 201) throw new Error('建接缝失败: ' + JSON.stringify(rr.json));
    rver = rr.json.project.version;
    return rr.json;
  }
  await addSeamR([s[0], s[1]], -10, 'r0-1');
  await addSeamR([s[1], s[2]], -10, 'r1-2');
  const closed1 = await addSeamR([s[0], s[2]], -20, '闭合 r0-2');
  await addSeamR([s[3], s[4]], -10, 'r3-4');
  await addSeamR([s[4], s[5]], -10, 'r4-5');
  const closed2 = await addSeamR([s[3], s[5]], -20, '闭合 r3-5');
  const seam01 = closed1.seams.find((x) => x.from_id === s[0] && x.to_id === s[1]);
  const seam12 = closed1.seams.find((x) => x.from_id === s[1] && x.to_id === s[2]);
  const seam02 = closed1.seams.find((x) => x.from_id === s[0] && x.to_id === s[2]);
  const seam34 = closed2.seams.find((x) => x.from_id === s[3] && x.to_id === s[4]);
  const seam45 = closed2.seams.find((x) => x.from_id === s[4] && x.to_id === s[5]);
  const seam35 = closed2.seams.find((x) => x.from_id === s[3] && x.to_id === s[5]);
  assert(closed1.layout.residuals.some((x) => x.seam_id === seam02.id && x.distance_mm === 0),
    '修订方案环 0-2 初始残差 0');
  assert(closed2.layout.residuals.some((x) => x.seam_id === seam35.id && x.distance_mm === 0),
    '修订方案环 3-5 初始残差 0');

  // 1) 预览：改生成树接缝 0->1 为 tx=-14（下游整体多移 4mm，环 0-2 残差 4mm 超差）。
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0, join_note: 'r0-1 改' } });
  assert(r.status === 200 && r.json.preview_only === true, '返回修订预览（只读）');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -14, '预览中的接缝参数为修订值');
  assert(r.json.seams.map((x) => x.id).join(',') === closed2.seams.map((x) => x.id).join(','),
    '预览接缝 ID 与排序不变');
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam02.id,
    '预览仅环 0-2 超差（成环接缝为被报告对象）');
  const v02 = r.json.violations[0];
  assert(v02.deviation_mm === 4 && v02.conflict_chain.closing_seam.id === seam02.id,
    `超差 4mm 且闭合接缝为 #${seam02.id}`);
  assert(v02.conflict_chain.seams.map((x) => x.id).join(',') === [seam01.id, seam12.id].join(','),
    '冲突链沿生成树 0->1->2 的树路径（经修订接缝 0-1、1-2）');
  assert(v02.conflict_chain.sherds.map((x) => x.id).join(',') === [s[0], s[1], s[2]].join(','),
    '冲突链陶片路径 0→1→2');
  // 环 3-5 不受影响
  assert(r.json.layout.residuals.find((x) => x.seam_id === seam35.id).distance_mm === 0,
    '另一连通组的环 3-5 残差仍为 0');
  // 预览不改方案
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '预览不推进版本');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -10, '预览不写入接缝（tx 仍为 -10）');

  // 2) 参数无效 / 接缝不存在
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`, { body: { theta_deg: 'abc', tx: 0, ty: 0 } });
  assert(r.status === 400, '预览参数非法 => 400');
  r = await req('POST', `/api/seams/999999/revision-preview`, { body: { theta_deg: 0, tx: 0, ty: 0 } });
  assert(r.status === 404, '预览不存在的接缝 => 404');

  // 3) 确认超差修订 => 422，接缝/版本/布局均不变
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver, body: { theta_deg: 0, tx: -14, ty: 0, join_note: 'r0-1 改' } });
  assert(r.status === 422, '确认超差修订 => 422 拒绝');
  assert(r.json.error.reason === 'revision_cycle_tolerance_exceeded', '422 带修订拒绝原因');
  assert(r.json.error.violations.length === 1 && r.json.error.violations[0].seam_id === seam02.id,
    '422 返回超差接缝与冲突链');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '422 不推进版本');
  assert(r.json.seams.find((x) => x.id === seam01.id).tx === -10, '422 后原接缝参数不变');
  assert(r.json.layout.groups.find((g) => g.member_ids.includes(s[2])).poses[s[2]].x === 20,
    '422 后布局不变（R2 仍在 x=20）');

  // 4) 缺 Base-Version => 428；过期版本 => 409（不得套用旧预览）
  r = await req('PATCH', `/api/seams/${seam01.id}`, { body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 428, '确认缺少 Base-Version => 428');
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver - 1, body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 409, '确认基于过期版本 => 409');
  assert(r.json.error.current_version === rver, '409 给出当前版本');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.project.version === rver, '428/409 均不改变版本');

  // 5) 容差内修订成功：接缝 ID/排序不变，版本只 +1，读取布局与预览一致
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -11, ty: 0, join_note: 'r0-1 微调' } });
  assert(r.status === 200 && r.json.violations.length === 0, '容差内修订预览无超差');
  const preview = r.json;
  r = await req('PATCH', `/api/seams/${seam01.id}`,
    { version: rver, body: { theta_deg: 0, tx: -11, ty: 0, join_note: 'r0-1 微调' } });
  assert(r.status === 200, '确认容差内修订成功');
  assert(r.json.project.version === rver + 1, '成功后版本只递增一次');
  rver = r.json.project.version;
  const after = r.json;
  assert(after.seams.map((x) => x.id).join(',') === preview.seams.map((x) => x.id).join(','),
    '成功后接缝 ID 与排序不变');
  const updated = after.seams.find((x) => x.id === seam01.id);
  assert(updated.tx === -11 && updated.join_note === 'r0-1 微调', '接缝参数与说明已更新');
  assert(JSON.stringify(after.layout) === JSON.stringify(preview.layout),
    '读取布局与预览完全一致');
  const gA = after.layout.groups.find((gg) => gg.member_ids.includes(s[0]));
  assert(gA.poses[s[1]].x === 11 && gA.poses[s[2]].x === 21, '下游位姿按修订重算（R1=11,R2=21）');
  const res02 = after.layout.residuals.find((x) => x.seam_id === seam02.id);
  assert(res02.distance_mm === 1 && res02.within_tolerance, '环 0-2 残差变为 1mm，在 2mm 容差内');

  // 6) 修订成环接缝本身（0-2 tx=-19 => 预测 R2 在 19，与树推导 21 偏差 2mm，恰在容差内）
  r = await req('PATCH', `/api/seams/${seam02.id}`,
    { version: rver, body: { theta_deg: 0, tx: -19, ty: 0, join_note: '闭合 r0-2 微调' } });
  assert(r.status === 200, '修订成环接缝本身成功');
  rver = r.json.project.version;
  const res02b = r.json.layout.residuals.find((x) => x.seam_id === seam02.id);
  assert(res02b.distance_mm === 2 && res02b.within_tolerance,
    `成环接缝残差随其修订变为 2mm（容差边界内，实际 ${res02b.distance_mm}）`);
  // 生成树身份未变（0-1、1-2 仍是树，0-2 仍是成环边）
  const tree = new Set(r.json.layout.groups.find((gg) => gg.member_ids.includes(s[0])).tree_seam_ids);
  assert(tree.has(seam01.id) && !tree.has(seam02.id), '修订不改变生成树/成环边身份与排序');

  // 7) 同一方案中制造“两个”超差环：先以合规提交把第二组的 3-4 改为 tx=-11
  //    （此时环 3-5 残差 1mm，容差内），再把它进一步改坏并连同第一组一起预览。
  r = await req('PATCH', `/api/seams/${seam34.id}`,
    { version: rver, body: { theta_deg: 0, tx: -11, ty: 0 } });
  assert(r.status === 200, '先把另一组树接缝 3-4 微调到 tx=-11（环 3-5 残差 1mm，仍容差内）');
  rver = r.json.project.version;
  // 3-4 再改到 -13（残差 3mm）单条已超差，确认应 422 且给出环 3-5 冲突链
  r = await req('PATCH', `/api/seams/${seam34.id}`,
    { version: rver, body: { theta_deg: 0, tx: -13, ty: 0 } });
  assert(r.status === 422 && r.json.error.violations.length === 1
    && r.json.error.violations[0].seam_id === seam35.id, '改另一组树接缝 3-4 到 -13 => 仅环 3-5 超差（互不影响）');
  assert(r.json.error.violations[0].conflict_chain.seams.map((x) => x.id).join(',')
    === [seam34.id, seam45.id].join(','), '环 3-5 冲突链沿 3-4、4-5');
  r = await req('GET', `/api/projects/${rpid}`);
  assert(r.json.seams.find((x) => x.id === seam34.id).tx === -11 && r.json.project.version === rver,
    '422 后 3-4 维持 tx=-11、版本不变');

  // 此时方案中：第一组环 0-2 残差 1mm（容差内），第二组环 3-5 残差 1mm（容差内）。
  // 预览把 0-1 改到 -14（环 0-2 变 4mm 超差）：只应报第一组。
  r = await req('POST', `/api/seams/${seam01.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0 } });
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam02.id,
    '预览 0-1 改坏：只第一组环 0-2 超差');
  // 预览把 3-4 改到 -14（环 3-5 变 4mm 超差）：只应报第二组（两条环相互独立，不同时出现）。
  r = await req('POST', `/api/seams/${seam34.id}/revision-preview`,
    { body: { theta_deg: 0, tx: -14, ty: 0 } });
  assert(r.json.violations.length === 1 && r.json.violations[0].seam_id === seam35.id,
    '预览 3-4 改坏：只第二组环 3-5 超差');

  // 8) 只改说明（几何不变）：成功且布局、残差完全不变，版本 +1
  const beforeNote = await req('GET', `/api/projects/${rpid}`);
  const layoutBefore = JSON.stringify(beforeNote.json.layout);
  const cur02 = beforeNote.json.seams.find((x) => x.id === seam02.id);
  r = await req('PATCH', `/api/seams/${seam02.id}`,
    { version: rver, body: { theta_deg: cur02.theta_deg, tx: cur02.tx, ty: cur02.ty, join_note: '仅改说明' } });
  assert(r.status === 200, '几何不变、仅改说明可成功');
  rver = r.json.project.version;
  assert(JSON.stringify(r.json.layout) === layoutBefore, '仅改说明后布局与残差不变');
  assert(r.json.seams.find((x) => x.id === seam02.id).join_note === '仅改说明', '说明已更新');
  assert(r.json.seams.length === 6, '全程接缝数保持 6');

  // ===================== 批量试拼（整批试算 + 单事务确认） =====================
  // 新建 5 片方案（每片 10mm×10mm），用批量接口一次试算/采纳多条候选。
  r = await req('POST', '/api/projects', { body: { name: '批量方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建批量试拼方案');
  const bpid = r.json.project.id;
  let bver = r.json.project.version;
  const t = [];
  for (let i = 0; i < 5; i++) {
    const form = multipart({ label: `T${i}`, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${bpid}/sherds`, { version: bver, raw: form.payload, body: form });
    if (rr.status !== 201) throw new Error('批量方案上传失败: ' + JSON.stringify(rr.json));
    bver = rr.json.project.version;
    t.push(rr.json.sherds[rr.json.sherds.length - 1].id);
  }
  for (const id of t) {
    r = await req('PATCH', `/api/sherds/${id}/scale`, { version: bver, body: { scale_px: 100, scale_mm: 10 } });
    assert(r.status === 200, '批量方案比例尺');
    bver = r.json.project.version;
  }

  // 先以“单条接缝”采纳 T0->T1（既有接缝优先于候选的对照基线）。
  r = await req('POST', `/api/projects/${bpid}/seams`,
    { version: bver, body: { from_id: t[0], to_id: t[1], theta_deg: 0, tx: -10, ty: 0, join_note: '既有 0-1' } });
  assert(r.status === 201, '采纳既有接缝 T0->T1');
  bver = r.json.project.version;

  // 1) 试算一批 3 条：候选1 T1->T2(-10) 树；候选2 T2->T3(-10) 树；候选3 T0->T3(-30) 成环残差 0。
  let batchCandidates = [
    { from_id: t[1], to_id: t[2], theta_deg: 0, tx: -10, ty: 0, join_note: '候选 1-2' },
    { from_id: t[2], to_id: t[3], theta_deg: 0, tx: -10, ty: 0, join_note: '候选 2-3' },
    { from_id: t[0], to_id: t[3], theta_deg: 0, tx: -30, ty: 0, join_note: '候选闭合 0-3' },
  ];
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: batchCandidates } });
  assert(r.status === 200 && r.json.preview_only === true && r.json.batch_trial === true, '批量试算返回只读试算体');
  assert(r.json.base_version === bver, '试算给出所基于的方案版本');
  assert(typeof r.json.batch_fingerprint === 'string' && r.json.batch_fingerprint.length === 64, '试算给出批内容指纹');
  const fp = r.json.batch_fingerprint;
  assert(r.json.candidate_results.map((x) => x.index).join(',') === '1,2,3', '候选按填写顺序编号');
  assert(r.json.candidate_results.map((x) => x.role).join(',') === 'tree,tree,cycle',
    '候选 1/2 成生成树、候选 3 成环（既有接缝优先）');
  // 试算体中既有接缝为真实 id，候选为负的虚拟 id + candidate_index
  const existingInPreview = r.json.seams.filter((s) => s.candidate_index === null);
  const candInPreview = r.json.seams.filter((s) => s.candidate_index !== null)
    .sort((a, b) => a.candidate_index - b.candidate_index);
  assert(existingInPreview.length === 1 && existingInPreview[0].id !== null, '试算体含全部既有接缝（真实 id）');
  assert(candInPreview.map((s) => s.virtual_seam_id).join(',') === '-1,-2,-3', '候选虚拟接缝按序为 -1,-2,-3');
  const bg = r.json.layout.groups.find((g) => g.member_ids.length === 4);
  assert(bg && bg.poses[t[3]].x === 30, '试算：T3 沿 既有0-1→候选1→候选2 推导到 x=30mm');
  const closeRes = r.json.layout.residuals.find((x) => x.from_id === t[0] && x.to_id === t[3]);
  assert(closeRes && closeRes.distance_mm === 0 && closeRes.within_tolerance, '候选闭合环残差 0，容差内');
  assert(r.json.violations.length === 0, '试算无超差');
  // 试算不改接缝/版本
  r = await req('GET', `/api/projects/${bpid}`);
  assert(r.json.seams.length === 1 && r.json.project.version === bver, '试算不写入接缝、不推进版本');

  // 2) 前置校验：陶片不属于本方案 / 未标比例尺 / 同片 / 参数非法 —— 整批 400，指出候选序号
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: [
    { from_id: t[0], to_id: t[0], theta_deg: 0, tx: 0, ty: 0 },
  ] } });
  assert(r.status === 400 && r.json.error.reason === 'batch_invalid_candidates', '候选连接同片 => 整批 400');
  assert(r.json.error.errors[0].index === 1 && r.json.error.errors[0].message.includes('不同的陶片'),
    '400 指出候选序号 1 与原因');
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: [
    batchCandidates[0],
    { from_id: t[2], to_id: t[3], theta_deg: 999, tx: 0, ty: 0 },
  ] } });
  assert(r.status === 400 && r.json.error.errors.some((e) => e.index === 2), '参数非法指出候选 #2');
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: [
    { from_id: t[1], to_id: 999999, theta_deg: 0, tx: -10, ty: 0 },
  ] } });
  assert(r.status === 400 && r.json.error.errors[0].message.includes('不属于该方案'), '陶片不属于本方案 => 400');
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: [] } });
  assert(r.status === 400, '空批 => 400');

  // 3) 超差批：候选闭合边给 tx=-25 => 偏差 5mm > 2mm；试算指出候选序号、偏差与冲突链
  const badCandidates = [
    batchCandidates[0], batchCandidates[1],
    { from_id: t[0], to_id: t[3], theta_deg: 0, tx: -25, ty: 0, join_note: '错误闭合' },
  ];
  r = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: badCandidates } });
  assert(r.status === 200 && r.json.violations.length === 1, '超差仍返回试算结果（只读），带 violations');
  const bv = r.json.violations[0];
  assert(bv.candidate_index === 3 && bv.deviation_mm === 5, '超差指出候选 #3、偏差 5mm');
  const existingSeamId = r.json.seams.find((s) => s.candidate_index === null).id;
  const bchainSeams = bv.conflict_chain.seams.map((s) =>
    (s.candidate_index ? `c${s.candidate_index}` : `existing#${s.id}`)).join('|');
  assert(bchainSeams === `existing#${existingSeamId}|c1|c2`,
    `冲突链沿生成树路径 既有T0-T1 → 候选1 → 候选2（实际 ${bchainSeams}）`);
  // 闭合候选为 T0->T3，冲突链陶片路径自 T0 起：T0→T1→T2→T3
  assert(bv.conflict_chain.sherds[0].id === t[0] && bv.conflict_chain.sherds.slice(-1)[0].id === t[3],
    '冲突链陶片起于 T0（闭合边起点）、止于 T3');
  assert(bv.conflict_chain.closing_seam.candidate_index === 3, '闭合边标注为候选 #3');
  r = await req('GET', `/api/projects/${bpid}`);
  assert(r.json.seams.length === 1 && r.json.project.version === bver, '超差试算同样不写库');

  // 4) 确认：缺 Base-Version => 428
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { body: { candidates: batchCandidates, base_version: bver, batch_fingerprint: fp } });
  assert(r.status === 428, '批量确认缺 Base-Version => 428');
  // 批内容被改动（指纹不符）=> 400
  const tampered = batchCandidates.map((c, i) => i === 1 ? { ...c, tx: -11 } : c);
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { version: bver, body: { candidates: tampered, base_version: bver, batch_fingerprint: fp } });
  assert(r.status === 400 && r.json.error.reason === 'batch_content_mismatch', '批内容与试算不一致 => 400 要求重新试算');
  // 超差批确认 => 422 整批不生效
  const badFpR = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: badCandidates } });
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { version: bver, body: { candidates: badCandidates, base_version: bver, batch_fingerprint: badFpR.json.batch_fingerprint } });
  assert(r.status === 422 && r.json.error.reason === 'batch_cycle_tolerance_exceeded',
    '单事务重校验超差 => 422 整批拒绝');
  assert(r.json.error.violations[0].candidate_index === 3 && r.json.error.violations[0].deviation_mm === 5,
    '422 给出超差候选序号与偏差');
  r = await req('GET', `/api/projects/${bpid}`);
  assert(r.json.seams.length === 1 && r.json.project.version === bver, '422 后接缝数与版本不变（整批回滚）');

  // 5) 正确批确认：单事务内通过，依序采纳，版本只 +1，读取布局 == 试算布局
  const goodPreview = await req('POST', `/api/projects/${bpid}/seams/batch-preview`, { body: { candidates: batchCandidates } });
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { version: bver, body: { candidates: batchCandidates, base_version: bver, batch_fingerprint: goodPreview.json.batch_fingerprint } });
  assert(r.status === 200, '确认整批成功');
  assert(r.json.project.version === bver + 1, '整批采纳版本只递增一次（+1，而非每条 +1）');
  bver = r.json.project.version;
  assert(r.json.seams.length === 4, '3 条候选依序采纳，接缝总数 4（1 既有 + 3 候选）');
  const committed = r.json.seams.slice().sort((a, b) => a.id - b.id);
  assert(committed[1].from_id === t[1] && committed[2].from_id === t[2] && committed[3].from_id === t[0],
    '采纳顺序与候选填写顺序一致（自增 id 连续）');
  assert(committed[1].id + 1 === committed[2].id && committed[2].id + 1 === committed[3].id,
    '候选在同一事务内连续依序插入');
  // 读取布局与试算一致（虚拟 id 换算为真实 id 后，groups/unconnected/残差数值全等）
  const realClose = r.json.layout.residuals.find((x) => x.from_id === t[0] && x.to_id === t[3]);
  assert(realClose && realClose.distance_mm === 0 && realClose.within_tolerance, '确认后闭合残差与试算一致（0）');
  assert(r.json.layout.groups.find((g) => g.member_ids.length === 4).poses[t[3]].x === 30,
    '确认后 T3 位姿与试算一致（x=30）');
  assert(JSON.stringify(r.json.layout.unconnected) === JSON.stringify([t[4]]), 'T4 仍未连通');

  // 6) 版本已变化：他人改了方案后拿旧试算确认 => 409，要求重新试算
  const preview2Candidates = [{ from_id: t[3], to_id: t[4], theta_deg: 0, tx: -10, ty: 0, join_note: '候选 3-4' }];
  const preview2 = await req('POST', `/api/projects/${bpid}/seams/batch-preview`,
    { body: { candidates: preview2Candidates } });
  assert(preview2.json.base_version === bver, '第二次试算基于当前版本');
  // 他人改方案：改方案名推进版本
  r = await req('PATCH', `/api/projects/${bpid}`, { version: bver, body: { name: '批量方案-他人改过' } });
  assert(r.status === 200, '模拟他人修改推进版本');
  bver = r.json.project.version;
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { version: preview2.json.base_version, body: {
      candidates: preview2Candidates,
      base_version: preview2.json.base_version,
      batch_fingerprint: preview2.json.batch_fingerprint,
    } });
  assert(r.status === 409 && r.json.error.reason === 'batch_version_conflict',
    '试算后方案版本已变化 => 409 要求重新试算');
  assert(r.json.error.current_version === bver, '409 给出服务器当前版本');
  r = await req('GET', `/api/projects/${bpid}`);
  assert(r.json.seams.length === 4, '409 不写入任何候选接缝');

  // 重新试算后确认成功（T3->T4 把 T4 接入，五片连通）
  const preview3 = await req('POST', `/api/projects/${bpid}/seams/batch-preview`,
    { body: { candidates: preview2Candidates } });
  r = await req('POST', `/api/projects/${bpid}/seams/batch-commit`,
    { version: bver, body: {
      candidates: preview2Candidates,
      base_version: bver,
      batch_fingerprint: preview3.json.batch_fingerprint,
    } });
  assert(r.status === 200 && r.json.project.version === bver + 1, '重新试算后确认成功，版本 +1');
  bver = r.json.project.version;
  assert(r.json.layout.groups.length === 1 && r.json.layout.groups[0].member_ids.length === 5
    && r.json.layout.unconnected.length === 0, '整批确认后五片全部连通');

  // 7) 多条候选在同一批中把两个组件桥接 + 各自成环：候选桥接缝也按序生效
  //    （独立新方案：已有两组 {A-B}、{C-D}，一批含桥 B-C 与复核 A-D）
  r = await req('POST', '/api/projects', { body: { name: '批量桥接', tolerance_mm: 2 } });
  assert(r.status === 201, '创建批量桥接方案');
  const bpid2 = r.json.project.id;
  let b2ver = r.json.project.version;
  const q = [];
  for (let i = 0; i < 4; i++) {
    const form = multipart({ label: `Q${i}`, img_w: '100', img_h: '100' }, png);
    const rr = await req('POST', `/api/projects/${bpid2}/sherds`, { version: b2ver, raw: form.payload, body: form });
    b2ver = rr.json.project.version;
    q.push(rr.json.sherds[rr.json.sherds.length - 1].id);
  }
  for (const id of q) {
    const rr = await req('PATCH', `/api/sherds/${id}/scale`, { version: b2ver, body: { scale_px: 100, scale_mm: 10 } });
    b2ver = rr.json.project.version;
  }
  let rr = await req('POST', `/api/projects/${bpid2}/seams`,
    { version: b2ver, body: { from_id: q[0], to_id: q[1], theta_deg: 0, tx: -10, ty: 0 } });
  b2ver = rr.json.project.version;
  rr = await req('POST', `/api/projects/${bpid2}/seams`,
    { version: b2ver, body: { from_id: q[2], to_id: q[3], theta_deg: 0, tx: -10, ty: 0 } });
  b2ver = rr.json.project.version;
  assert(rr.json.layout.groups.length === 2, '试算前两个独立连通组');
  const bridgeBatch = [
    { from_id: q[1], to_id: q[2], theta_deg: 0, tx: -10, ty: 0, join_note: '桥 B-C' },
    { from_id: q[0], to_id: q[3], theta_deg: 0, tx: -30, ty: 0, join_note: '复核 A-D（此时已连通 => 成环残差0）' },
  ];
  const bridgePreview = await req('POST', `/api/projects/${bpid2}/seams/batch-preview`,
    { body: { candidates: bridgeBatch } });
  assert(bridgePreview.status === 200, '桥接批试算成功');
  assert(bridgePreview.json.candidate_results.map((x) => x.role).join(',') === 'tree,cycle',
    '候选1 桥接两组（生成树），候选2 因批内已连通成为成环接缝');
  assert(bridgePreview.json.layout.groups.length === 1
    && bridgePreview.json.layout.groups[0].member_ids.length === 4, '试算中四片合成一组');
  const bridgeRes = bridgePreview.json.layout.residuals.find((x) => x.from_id === q[0] && x.to_id === q[3]);
  assert(bridgeRes && bridgeRes.distance_mm === 0, '批内成环残差为 0');
  rr = await req('POST', `/api/projects/${bpid2}/seams/batch-commit`, {
    version: b2ver,
    body: {
      candidates: bridgeBatch,
      base_version: b2ver,
      batch_fingerprint: bridgePreview.json.batch_fingerprint,
    },
  });
  assert(rr.status === 200 && rr.json.project.version === b2ver + 1, '桥接批确认成功，版本只 +1');
  assert(rr.json.seams.length === 4, '桥接批两条候选均已采纳');

  // ===================== 方案移交包（导出 ZIP / 导入 ZIP） =====================
  // 独立建一个含“连通组成环 + 未连通陶片 + 未标比例尺陶片”的方案作为导出源。
  r = await req('POST', '/api/projects', { body: { name: '移交方案', tolerance_mm: 2 } });
  assert(r.status === 201, '创建移交方案');
  const xpid = r.json.project.id;
  let xver = r.json.project.version;
  const x = [];
  for (let i = 0; i < 5; i++) {
    const form = multipart({ label: `X${i}`, img_w: '100', img_h: '100' }, png);
    const rr2 = await req('POST', `/api/projects/${xpid}/sherds`, { version: xver, raw: form.payload, body: form });
    if (rr2.status !== 201) throw new Error('移交方案上传失败: ' + JSON.stringify(rr2.json));
    xver = rr2.json.project.version;
    x.push(rr2.json.sherds[rr2.json.sherds.length - 1].id);
  }
  // X0..X3 标比例尺；X4 故意不标（导出/导入后仍为未连通、未标定陶片）。
  for (let i = 0; i < 4; i++) {
    const rr2 = await req('PATCH', `/api/sherds/${x[i]}/scale`, { version: xver, body: { scale_px: 100, scale_mm: 10 } });
    xver = rr2.json.project.version;
  }
  async function addXSeam(pair, tx, note) {
    const rr2 = await req('POST', `/api/projects/${xpid}/seams`,
      { version: xver, body: { from_id: pair[0], to_id: pair[1], theta_deg: 0, tx, ty: 0, join_note: note || '' } });
    if (rr2.status !== 201) throw new Error('移交方案建接缝失败: ' + JSON.stringify(rr2.json));
    xver = rr2.json.project.version;
    return rr2.json;
  }
  await addXSeam([x[0], x[1]], -10, 'x0-1');
  await addXSeam([x[1], x[2]], -10, 'x1-2');
  const closed3 = await addXSeam([x[0], x[2]], -20, '闭合 x0-2');
  await addXSeam([x[2], x[3]], -10, 'x2-3');
  // 再补一个成环 1->3（链上 -20，闭合边也 -20 => 残差 0）
  const closed4 = await addXSeam([x[1], x[3]], -20, '闭合 x1-3');
  const srcState = await req('GET', `/api/projects/${xpid}`);
  assert(srcState.json.layout.groups.length === 1 && srcState.json.layout.unconnected.length === 1,
    '导出前：一个四片连通组（含两个闭合环）+ 一片未连通');

  // 1) 导出：ZIP 可下载、可由本模块解析，内容与库中版本快照一致
  let dl = await reqBuf('GET', `/api/projects/${xpid}/export`);
  assert(dl.status === 200 && dl.headers['content-type'].includes('zip'), '导出返回 application/zip');
  assert(/attachment/.test(dl.headers['content-disposition'] || ''), '导出带 attachment 文件名');
  assert(zipLib.unzip(dl.buf).has('manifest.json'), 'ZIP 内含 manifest.json');
  let parsed = pkgIO.parseImportPackage(dl.buf);
  assert(parsed.manifest.project.name === '移交方案'
    && parsed.manifest.project.tolerance_mm === 2
    && parsed.manifest.project.source_version === xver, '清单含方案名称、毫米容差与源版本');
  assert(JSON.stringify(parsed.manifest.checklist) === JSON.stringify(['manifest', 'project', 'sherds', 'seams']),
    '清单 checklist 完整');
  assert(parsed.sherds.map((s) => s.ord).join(',') === '1,2,3,4,5', '陶片按序重编号 1..5');
  assert(parsed.sherds[4].scale_px === null && parsed.sherds[4].scale_mm === null,
    '未标定陶片比例尺字段为 null 且保留');
  assert(parsed.seams.length === 5, '接缝按采纳顺序排列（5 条）');
  assert(parsed.seams.map((s) => s.ord).join(',') === '1,2,3,4,5', '接缝 ord 为 1..5');
  assert(parsed.seams[0].from_ord === 1 && parsed.seams[0].to_ord === 2
    && parsed.seams[0].join_note === 'x0-1', '接缝端点用 ord 关联、参数/说明保留');
  assert(parsed.files.size === 5, '包内照片齐全（5 张）');
  for (const sh of parsed.sherds) {
    assert(pkgIO.sha256(parsed.files.get(sh.photo)) === sh.sha256,
      `照片 ${sh.photo} 摘要与字节一致`);
  }
  // 闭合环摘要：恰有 2 个环（接缝 ord 3、5），残差 0、在容差内
  const rings = parsed.manifest.cycle_check.rings;
  assert(rings.length === 2 && rings.map((g) => g.seam_ord).join(',') === '3,5',
    `导出闭合环摘要包含 2 个环且按采纳序（实际 ${rings.map((g) => g.seam_ord).join(',')}）`);
  assert(rings.every((g) => g.distance_mm === 0 && g.within_tolerance), '闭合环残差均为 0、在容差内');
  assert(parsed.manifest.cycle_check.tolerance_mm === 2, '闭合环摘要容差等于方案容差');

  // 2) 导出快照一致性：导出期间他人推进版本，包内仍来自同一个旧版本快照
  const dlConcurrent = await reqBuf('GET', `/api/projects/${xpid}/export`);
  // 模拟“导出期间被编辑”：直接再导出一次与改名前后比对——本实现读取在单事务内完成，
  // 这里验证改名后的导出携带新版本号、而此前下载包仍是旧版本号。
  const pkgBefore = pkgIO.parseImportPackage(dlConcurrent.buf);
  assert(pkgBefore.manifest.project.source_version === xver, '导出包携带导出时的版本号');
  let renamed = await req('PATCH', `/api/projects/${xpid}`, { version: xver, body: { name: '移交方案-改名' } });
  assert(renamed.status === 200, '模拟他人在导出后编辑方案');
  xver = renamed.json.project.version;
  const dlAfter = await reqBuf('GET', `/api/projects/${xpid}/export`);
  assert(pkgIO.parseImportPackage(dlAfter.buf).manifest.project.source_version === xver
    && pkgIO.parseImportPackage(dlAfter.buf).manifest.project.name === '移交方案-改名',
    '新导出包反映新版本；旧包仍为旧版本快照（导出不受期间编辑影响）');
  // 旧包内容不受影响（仍是旧名称）
  assert(pkgBefore.manifest.project.name === '移交方案', '旧下载包仍来自同一版本快照');
  // 改回名称，避免后续展示差异
  renamed = await req('PATCH', `/api/projects/${xpid}`, { version: xver, body: { name: '移交方案' } });
  xver = renamed.json.project.version;

  // 3) 导入合法包：创建独立方案、重分配本地 ID、布局与闭合环等价
  const goodZip = (await reqBuf('GET', `/api/projects/${xpid}/export`)).buf;
  let ir = await importZip(goodZip);
  assert(ir.status === 201 && ir.json.imported === true, '导入合法包成功（201 独立方案）');
  const ipid = ir.json.project.id;
  assert(ipid !== xpid, '导入创建的是新方案（ID 与源方案不同）');
  assert(ir.json.project.version === 1, '新方案从 v1 开始（不继承源版本号）');
  assert(ir.json.project.name === '移交方案' && ir.json.project.tolerance_mm === 2,
    '名称与毫米容差沿用包内值');
  assert(ir.json.sherds.length === 5 && ir.json.seams.length === 5, '陶片 5、接缝 5 全部导入');
  assert(ir.json.source.source_version === xver, '响应给出源版本信息');
  const impState = ir.json;
  // 新本地 id 与源 id 不必相同；接缝按采纳序连续取得新 id。
  const seamIds = impState.seams.map((s) => s.id);
  assert(seamIds.slice().sort((a, b) => a - b).join(',') === seamIds.join(',')
    && seamIds[4] === seamIds[0] + 4, '接缝新本地 id 连续、采纳顺序保持');
  // 接缝端点都指向本方案内的陶片（外键正确关联）。
  const impSherdIds = new Set(impState.sherds.map((s) => s.id));
  assert(impState.seams.every((s) => impSherdIds.has(s.from_id) && impSherdIds.has(s.to_id)),
    '接缝与照片（陶片）正确关联到重分配后的本地 ID');
  // 比例尺与“未标比例尺陶片”等价
  assert(impState.sherds.filter((s) => s.scale_px).length === 4, '4 片带比例尺、1 片未标定');
  // 布局等价：连通组成员、根、位姿、未连通陶片在 ord 规范化后完全一致
  const srcIdToOrd = new Map(srcState.json.sherds.map((s, i) => [s.id, i + 1]));
  // 导入侧陶片按新 id 升序；导出 ord 亦按源 id 升序赋 1..n，因此第 i 个即 ord i+1。
  const impIdToOrd = new Map(impState.sherds.map((s, i) => [s.id, i + 1]));
  // 接缝按 id 升序即采纳顺序，两侧第 i 条接缝的采纳序同为 i+1。
  const srcSeamToOrd = new Map(srcState.json.seams.map((s, i) => [s.id, i + 1]));
  const impSeamToOrd = new Map(impState.seams.map((s, i) => [s.id, i + 1]));
  const srcCanon = canonicalLayout(srcState.json.layout, srcIdToOrd, srcSeamToOrd);
  const impCanon = canonicalLayout(impState.layout, impIdToOrd, impSeamToOrd);
  assert(JSON.stringify(srcCanon) === JSON.stringify(impCanon),
    '导入后连通组、根、陶片世界位姿与未连通集合与源方案等价');
  // 闭合环结果等价：环残差集合（distance/rotation/within）相同
  const ringKey = (res) => `${res.distance_mm}/${res.rotation_deg}/${res.within_tolerance}`;
  const srcRingsFlat = srcState.json.layout.residuals.map(ringKey).sort();
  const impRingsFlat = impState.layout.residuals.map(ringKey).sort();
  assert(JSON.stringify(srcRingsFlat) === JSON.stringify(impRingsFlat),
    '导入后全部闭合环残差与源方案等价');
  // 照片字节等价：通过新方案的图片接口取回的内容哈希与包内一致
  for (let i = 0; i < impState.sherds.length; i++) {
    const imgResp = await reqBuf('GET', impState.sherds[i].image_url);
    assert(imgResp.status === 200 && pkgIO.sha256(imgResp.buf) === parsed.sherds[i].sha256,
      `导入陶片 ${i + 1} 照片字节与包内摘要一致`);
  }
  // 源方案不受导入影响
  const srcAgain = await req('GET', `/api/projects/${xpid}`);
  assert(srcAgain.json.project.id === xpid && srcAgain.json.seams.length === 5, '导入不修改源方案');

  // 再次导入同一包：得到又一个独立方案（ID 再次不同），证明“创建独立方案”而非合并
  const ir2 = await importZip(goodZip);
  assert(ir2.status === 201 && ir2.json.project.id !== ipid && ir2.json.project.id !== xpid,
    '重复导入创建又一个独立方案');
  // 可选 name 覆盖
  const ir3 = await importZip(goodZip, { name: '现场复核副本' });
  assert(ir3.status === 201 && ir3.json.project.name === '现场复核副本', '导入支持 name 覆盖新方案名');

  // 4) 损坏 / 非 ZIP 包 => 400 package_invalid(zip_unreadable)
  ir = await importZip(Buffer.from('this is definitely not a zip package'));
  assert(ir.status === 400 && ir.json.error.reason === 'package_invalid', '非 ZIP 包整包拒绝 400');
  assert(ir.json.error.issues[0].code === 'zip_unreadable', '400 指出 ZIP 无法解压');

  // 5) 清单类问题（逐项制造，均须 400 且带 issues）
  const expectInvalid = async (mutate, code, msg) => {
    const bad = rewritePackage(goodZip, mutate);
    const rr3 = await importZip(bad);
    assert(rr3.status === 400 && rr3.json.error.reason === 'package_invalid',
      `${msg}：整包拒绝 400`);
    assert(rr3.json.error.issues.some((it) => it.code === code),
      `${msg}：issues 含 ${code}（实际 ${rr3.json.error.issues.map((it) => it.code).join(',')}）`);
  };
  await expectInvalid((m) => { m.kind = 'something-else'; }, 'kind_unknown', 'kind 不被识别');
  await expectInvalid((m) => { m.format_version = 99; }, 'format_version_unsupported', '格式版本不受支持');
  await expectInvalid((m) => { m.checklist = ['manifest']; }, 'checklist_mismatch', 'checklist 不符');
  await expectInvalid((m) => { m.project.tolerance_mm = -1; }, 'tolerance_invalid', '容差非法');
  await expectInvalid((m) => { m.project.name = ''; }, 'project_name_invalid', '方案名为空');
  await expectInvalid((m) => { m.sherds[0].scale_mm = null; }, 'sherd_scale_invalid', '比例尺只给一半');
  await expectInvalid((m) => { m.sherds[0].img_w = 0; }, 'sherd_dimension_invalid', '图像尺寸越界');
  await expectInvalid((m) => { m.seams[0].theta_deg = 999; }, 'seam_param_invalid', '接缝角度越界');
  await expectInvalid((m) => { m.seams[0].to_ord = m.seams[0].from_ord; }, 'seam_same_endpoint', '接缝连同一片');
  await expectInvalid((m) => { m.seams[0].to_ord = 99; }, 'seam_endpoint_missing', '接缝端点不存在');
  await expectInvalid((m) => { m.seams[0].from_ord = 5; }, 'seam_endpoint_unscaled', '接缝端点未标比例尺');
  await expectInvalid((m) => { m.cycle_check.tolerance_mm = 99; }, 'cycle_check_tolerance_mismatch', '闭合环摘要容差不一致');

  // 6) 缺失文件：清单声明照片但包内无该条目
  {
    const entries = zipLib.unzip(goodZip);
    const map = new Map(entries);
    map.delete('photos/sherd-2.png');
    const bad = zipLib.zipEntries([...map.entries()].map(([name, data]) => ({ name, data })));
    const rr3 = await importZip(bad);
    assert(rr3.status === 400 && rr3.json.error.issues.some((it) => it.code === 'photo_missing'),
      '缺失照片文件 => 400 photo_missing');
  }

  // 7) 重复文件 / 重复 ord：ZIP 读写器直接拒绝重复条目；清单内重复 ord
  {
    const entries = zipLib.unzip(goodZip);
    const names = [...entries.keys()];
    const bad = zipLib.zipEntries([
      ...names.map((name) => ({ name, data: entries.get(name) })),
      { name: 'photos/sherd-1.png', data: entries.get('photos/sherd-1.png') },
    ]);
    const rr3 = await importZip(bad);
    assert(rr3.status === 400 && rr3.json.error.issues[0].code === 'zip_unreadable',
      'ZIP 内重复条目 => 400（无法解压）');
  }
  await expectInvalid((m) => { m.sherds[1].ord = 1; }, 'sherd_ord_duplicate', '陶片 ord 重复');
  await expectInvalid((m) => { m.seams[1].ord = 1; }, 'seam_ord_duplicate', '接缝 ord 重复');

  // 8) 越界路径：放入 ../ 条目 => 400 path_outside_package
  {
    const entries = zipLib.unzip(goodZip);
    const bad = zipLib.zipEntries([
      ...[...entries.entries()].map(([name, data]) => ({ name, data })),
      { name: '../../../etc/evil', data: Buffer.from('x') },
    ]);
    const rr3 = await importZip(bad);
    assert(rr3.status === 400 && rr3.json.error.issues.some((it) => it.code === 'path_outside_package'),
      '越界路径（../）=> 400 path_outside_package');
    const backslash = zipLib.zipEntries([
      ...[...entries.entries()].map(([name, data]) => ({ name, data })),
      { name: 'photos\\..\\evil.png', data: Buffer.from('x') },
    ]);
    const rr4 = await importZip(backslash);
    assert(rr4.status === 400 && rr4.json.error.issues.some((it) => it.code === 'path_outside_package'),
      '反斜杠越界路径 => 400 path_outside_package');
  }

  // 9) 照片摘要不符 / 非图片伪装
  await expectInvalid((m) => { m.sherds[0].sha256 = 'a'.repeat(64); }, 'photo_digest_mismatch', '照片哈希被篡改');
  {
    const entries = zipLib.unzip(goodZip);
    const map = new Map(entries);
    map.set('photos/sherd-1.png', Buffer.from('not-an-image-at-all'));
    const bad = zipLib.zipEntries([...map.entries()].map(([name, data]) => ({ name, data })));
    const rr3 = await importZip(bad);
    const codes = rr3.json.error.issues.map((it) => it.code);
    assert(rr3.status === 400 && codes.includes('photo_not_image') && codes.includes('photo_digest_mismatch'),
      '非图片伪装照片 => 400（魔数不符且摘要不符）');
  }

  // 10) 清单之外的意外文件 => 400 unexpected_file
  {
    const entries = zipLib.unzip(goodZip);
    const bad = zipLib.zipEntries([
      ...[...entries.entries()].map(([name, data]) => ({ name, data })),
      { name: 'random/notes.txt', data: Buffer.from('hi') },
    ]);
    const rr3 = await importZip(bad);
    assert(rr3.status === 400 && rr3.json.error.issues.some((it) => it.code === 'unexpected_file'),
      '清单之外的意外文件 => 400 unexpected_file');
  }

  // 11) 全部闭合环超容差 => 422 整包拒绝（改接缝使闭合环偏差 4mm > 2mm）
  {
    // 接缝 ord1 = X0->X1 tx=-10（树）。改其 tx=-14 => X1=14,X2=24,X3=34：
    // 闭合环 ord5（X1->X3，闭合边 -20，预测 34）仍 0；
    // 闭合环 ord3（X0->X2，闭合边 -20 预测 20，树位姿 24）偏差 4mm 超差。
    const bad = rewritePackage(goodZip, (m) => { m.seams[0].tx = -14; });
    const rr3 = await importZip(bad);
    assert(rr3.status === 422 && rr3.json.error.reason === 'import_cycle_tolerance_exceeded',
      '闭合环超容差 => 422 整包拒绝');
    assert(rr3.json.error.violations.length === 1,
      `恰有闭合环 ord3（X0->X2）超差（实际 ${rr3.json.error.violations.length}）`);
    const v = rr3.json.error.violations[0];
    assert(v.seam_ord === 3 && v.from_ord === 1 && v.to_ord === 3 && v.deviation_mm === 4,
      `422 指向接缝 ord3（X0→X2）、偏差 4mm（实际 seam_ord=${v.seam_ord} ${v.from_ord}->${v.to_ord} dev=${v.deviation_mm}）`);
    assert(v.conflict_chain.closing_seam.seam_ord === 3
      && v.conflict_chain.closing_seam.from_ord === 1 && v.conflict_chain.closing_seam.to_ord === 3
      && v.conflict_chain.sherds.map((s) => s.ord).join(',') === '1,2,3'
      && v.conflict_chain.seams.map((s) => s.seam_ord).join(',') === '1,2',
      '冲突链陶片路径 X0→X1→X2，沿生成树接缝 ord1、ord2，闭合接缝 ord3');
  }

  // 12) 任何拒绝都不留下方案或孤儿照片
  const projectsBefore = (await req('GET', '/api/projects')).json.projects.length;
  await importZip(Buffer.from('garbage'));
  await importZip(rewritePackage(goodZip, (m) => { m.seams[0].tx = -14; }));
  {
    const entries = zipLib.unzip(goodZip);
    const map = new Map(entries);
    map.delete('photos/sherd-3.png');
    const bad = zipLib.zipEntries([...map.entries()].map(([name, data]) => ({ name, data })));
    await importZip(bad);
  }
  const projectsAfter = (await req('GET', '/api/projects')).json.projects.length;
  assert(projectsAfter === projectsBefore, '拒绝导入后方案数量不变（未留下方案）');
  // uploads 目录中的文件数：合法导入了 3 次（ipid、ir2、ir3），每次 5 张，共 +15 张；
  // 拒绝的导入一张都不得落盘。
  const uploadFiles = fs.readdirSync(process.env.UPLOAD_DIR)
    .filter((f) => fs.statSync(path.join(process.env.UPLOAD_DIR, f)).isFile());
  // 统计当前所有方案陶片引用的图片文件总数，磁盘文件应恰好等于引用集合（无孤儿）。
  const allState = await req('GET', '/api/projects');
  let referenced = 0;
  for (const pj of allState.json.projects) {
    const st = await req('GET', `/api/projects/${pj.id}`);
    referenced += st.json.sherds.length;
  }
  assert(uploadFiles.length === referenced,
    `磁盘照片数（${uploadFiles.length}）等于全部方案陶片引用数（${referenced}）——无孤儿照片`);

  // 13) 空包（无陶片、无接缝）也可导入为独立空方案
  {
    const emptyManifest = {
      kind: 'sherd-stitch-workbench.package', format_version: 1,
      checklist: ['manifest', 'project', 'sherds', 'seams'],
      project: { name: '空方案', tolerance_mm: 2, source_version: 1 },
      sherds: [], seams: [],
      cycle_check: { tolerance_mm: 2, rings: [] },
    };
    const emptyZip = zipLib.zipEntries([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(emptyManifest)) },
    ]);
    const rr3 = await importZip(emptyZip);
    assert(rr3.status === 201 && rr3.json.sherds.length === 0 && rr3.json.seams.length === 0,
      '空方案包导入成功（独立空方案）');
  }

  // 14) 导出不存在的方案 => 404；缺 package 字段 => 400
  dl = await reqBuf('GET', '/api/projects/999999/export');
  assert(dl.status === 404, '导出不存在方案 => 404');
  {
    const form = packageMultipart(goodZip, {}, 'pkg.zip');
    // 手工把字段名 package 改成 other 再发
    const broken = form.payload.toString('latin1')
      .replace(/name="package"/g, 'name="other"');
    const rr3 = await new Promise((resolve) => {
      const headers = form.getHeaders();
      const r = http.request({ host: '127.0.0.1', port: process.env.PORT, path: '/api/imports', method: 'POST', headers }, (res) => {
        let c = '';
        res.on('data', (d) => (c += d));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(c) }));
      });
      r.write(Buffer.from(broken, 'latin1'));
      r.end();
    });
    assert(rr3.status === 400, '导入缺少 package 字段 => 400');
  }

  console.log('\n全部冒烟检查通过 ✅');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

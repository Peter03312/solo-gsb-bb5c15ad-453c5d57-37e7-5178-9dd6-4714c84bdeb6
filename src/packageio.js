'use strict';

// 方案移交包（自包含 ZIP）的构造与导入校验。
//
// 包结构（条目名固定、一律相对路径、无绝对路径）：
//   manifest.json          清单：方案名称/容差、陶片（含比例尺与照片摘要）、
//                          按采纳顺序排列的接缝、导出时全部闭合环校验摘要
//   photos/sherd-1.jpg …   陶片照片（序号与 sherds[].ord 对应）
//
// 导入时“整包要么全部接受、要么整体拒绝”：本模块只做纯解析与结构校验，
// 不触碰数据库与磁盘；任何不合法项都收集进 issues[] 并抛 PackageError。
// 闭合环容差复核由服务器在 DB 事务内基于重映射后的陶片/接缝另行重算。

const crypto = require('crypto');
const { zipEntries, unzip, ZipError } = require('./zip');

const PACKAGE_KIND = 'sherd-stitch-workbench.package';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const PHOTO_RE = /^photos\/sherd-(\d+)\.(jpe?g|png|webp)$/i;

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

const LIMITS = {
  nameMax: 200,
  noteMax: 2000,
  labelMax: 200,
  toleranceMin: 0.01,
  toleranceMax: 10000,
  imgMin: 1,
  imgMax: 20000,
  scaleMin: 0.001,
  scaleMax: 100000,
  thetaMin: -360,
  thetaMax: 360,
  tMin: -100000,
  tMax: 100000,
};

const CHECKLIST = ['manifest', 'project', 'sherds', 'seams'];

class PackageError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'PackageError';
    this.issues = issues;
  }
}

// ---------- 导出 ----------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extOf(imageFile) {
  const ext = (imageFile || '').match(/\.([a-zA-Z0-9]+)$/);
  if (ext) return `.${ext[1].toLowerCase()}`;
  return '.jpg'; // 服务端历史兜底名 .img，实际内容按 JPEG 导出命名
}

// 从 DB 行构造“同一版本快照”的方案包字节流。
// rows: { project, sherds(ORDER BY id), seams(ORDER BY id), photoLoader(sherd) -> Buffer,
//         residualFor(seamId) -> { distance_mm, rotation_deg, within_tolerance } | null }
function buildExportZip(rows) {
  const { project, sherds, seams, photoLoader, residualFor } = rows;
  const ordBySherdId = new Map(sherds.map((s, i) => [s.id, i + 1]));

  const entries = [];
  const manifestSherds = sherds.map((s, i) => {
    const ord = i + 1;
    const photo = `photos/sherd-${ord}${extOf(s.image_file)}`;
    const data = photoLoader(s);
    if (!Buffer.isBuffer(data)) throw new PackageError(`陶片 #${s.id} 的照片不可读取`);
    entries.push({ name: photo, data });
    return {
      ord,
      label: s.label,
      photo,
      img_w: s.img_w,
      img_h: s.img_h,
      scale_px: s.scale_px,
      scale_mm: s.scale_mm,
      note: s.note || '',
      sha256: sha256(data),
      size_bytes: data.length,
    };
  });

  // 接缝采纳顺序即 seams 的 ORDER BY id 顺序；接缝 ord 从 1 起。
  const manifestSeams = seams.map((s, i) => ({
    ord: i + 1,
    from_ord: ordBySherdId.get(s.from_id),
    to_ord: ordBySherdId.get(s.to_id),
    theta_deg: s.theta_deg,
    tx: s.tx,
    ty: s.ty,
    join_note: s.join_note || '',
  }));

  // 导出时全部闭合环校验摘要：按采纳顺序列出所有成环接缝的闭合残差。
  const rings = [];
  seams.forEach((s, i) => {
    const r = residualFor(s.id);
    if (!r) return;
    rings.push({
      seam_ord: i + 1,
      from_ord: ordBySherdId.get(s.from_id),
      to_ord: ordBySherdId.get(s.to_id),
      distance_mm: r.distance_mm,
      rotation_deg: r.rotation_deg,
      within_tolerance: !!r.within_tolerance,
    });
  });

  const manifest = {
    kind: PACKAGE_KIND,
    format_version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    checklist: CHECKLIST.slice(),
    project: {
      name: project.name,
      tolerance_mm: project.tolerance_mm,
      source_version: project.version,
    },
    sherds: manifestSherds,
    seams: manifestSeams,
    cycle_check: {
      tolerance_mm: project.tolerance_mm,
      checked_at: new Date().toISOString(),
      rings,
    },
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  return zipEntries([{ name: MANIFEST_NAME, data: manifestBuf }, ...entries]);
}

// ---------- 导入 ----------

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 按文件头魔数识别照片真实格式；扩展名必须与之同属一类。
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  // RIFF .... WEBP
  if (buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

// 解析并全量校验导入包。任何不合法都抛 PackageError（issues[] 逐条列出）。
// 返回 { manifest, files: Map(photo路径 → Buffer), ordToSherd, sherds, seams }，
// 其中 sherds/seams 已按导入后需要的字段归一化（仍用 ord 标识，由服务器重映射本地 ID）。
function parseImportPackage(buffer) {
  let entries;
  try {
    entries = unzip(buffer, { maxEntries: MAX_ENTRIES, maxTotalBytes: MAX_TOTAL_BYTES });
  } catch (e) {
    if (e instanceof ZipError) throw new PackageError(`方案包无法解压：${e.message}`, [{ code: 'zip_unreadable', message: e.message }]);
    throw e;
  }

  const issues = [];
  const push = (code, message, where) => issues.push({ code, message, ...(where ? { where } : {}) });

  // ---- 1. 条目清单：缺失/重复/越界/意外文件 ----
  for (const name of entries.keys()) {
    if (name === MANIFEST_NAME || PHOTO_RE.test(name)) continue;
    // 越界路径（反斜杠、盘符、前导斜杠、.. 穿越等，白名单正则本已排除）单独归类。
    const looksTraversal = name.includes('\\')
      || /^[a-zA-Z]:/.test(name)
      || name.startsWith('/')
      || /(^|\/)\.\.(\/|$)/.test(name);
    push(
      looksTraversal ? 'path_outside_package' : 'unexpected_file',
      looksTraversal
        ? `包内存在越界路径条目：${name}`
        : `包内存在清单之外的意外文件：${name}`,
      name
    );
  }

  const manifestBuf = entries.get(MANIFEST_NAME);
  if (!manifestBuf) {
    push('manifest_missing', '缺少 manifest.json 清单');
    throw new PackageError('方案包缺少清单，整包拒绝', issues);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    push('manifest_invalid_json', `manifest.json 不是合法 JSON：${e.message}`);
    throw new PackageError('方案包清单无法解析，整包拒绝', issues);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    push('manifest_invalid', '清单根节点必须是对象');
    throw new PackageError('方案包清单结构非法，整包拒绝', issues);
  }

  // ---- 2. 信封 / checklist ----
  if (manifest.kind !== PACKAGE_KIND) push('kind_unknown', `清单 kind 不是 ${PACKAGE_KIND}`);
  if (!isInt(manifest.format_version)) {
    push('format_version_invalid', 'format_version 必须是整数');
  } else if (manifest.format_version !== FORMAT_VERSION) {
    push('format_version_unsupported', `仅支持方案包格式 v${FORMAT_VERSION}，收到 v${manifest.format_version}`);
  }
  if (!Array.isArray(manifest.checklist)
    || manifest.checklist.length !== CHECKLIST.length
    || CHECKLIST.some((c, i) => manifest.checklist[i] !== c)) {
    push('checklist_mismatch', `清单 checklist 必须且只能为 ${JSON.stringify(CHECKLIST)}`);
  }

  // ---- 3. 方案参数 ----
  const project = manifest.project;
  let toleranceMm = null;
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    push('project_invalid', '清单缺少 project 对象');
  } else {
    if (typeof project.name !== 'string' || !project.name.trim()) {
      push('project_name_invalid', '方案名称必须是非空字符串');
    } else if (project.name.length > LIMITS.nameMax) {
      push('project_name_invalid', `方案名称过长（最多 ${LIMITS.nameMax} 字符）`);
    }
    if (!isNum(project.tolerance_mm)) {
      push('tolerance_invalid', 'tolerance_mm 必须是数字');
    } else if (project.tolerance_mm < LIMITS.toleranceMin || project.tolerance_mm > LIMITS.toleranceMax) {
      push('tolerance_invalid',
        `tolerance_mm 超出允许范围（${LIMITS.toleranceMin} ~ ${LIMITS.toleranceMax}）`);
    } else {
      toleranceMm = project.tolerance_mm;
    }
  }

  // ---- 4. 陶片清单 ----
  const sherds = [];
  const ordSet = new Set();
  const photoSet = new Set();
  const ordToSherd = new Map();
  if (!Array.isArray(manifest.sherds)) {
    push('sherds_invalid', '清单 sherds 必须是数组');
  } else {
    manifest.sherds.forEach((sh, i) => {
      const where = `sherds[${i}]`;
      const fail = (code, msg) => push(code, msg, where);
      if (!sh || typeof sh !== 'object' || Array.isArray(sh)) {
        return fail('sherd_invalid', '陶片条目必须是对象');
      }
      if (!isInt(sh.ord) || sh.ord < 1) fail('sherd_ord_invalid', 'ord 必须是 ≥1 的整数');
      else if (ordSet.has(sh.ord)) fail('sherd_ord_duplicate', `陶片 ord=${sh.ord} 重复`);
      else ordSet.add(sh.ord);
      if (typeof sh.label !== 'string') fail('sherd_label_invalid', 'label 必须是字符串');
      else if (sh.label.length > LIMITS.labelMax) fail('sherd_label_invalid', `label 过长（最多 ${LIMITS.labelMax} 字符）`);
      if (typeof sh.note !== 'string') fail('sherd_note_invalid', 'note 必须是字符串');
      else if (sh.note.length > LIMITS.noteMax) fail('sherd_note_invalid', `note 过长（最多 ${LIMITS.noteMax} 字符）`);
      if (!isInt(sh.img_w) || sh.img_w < LIMITS.imgMin || sh.img_w > LIMITS.imgMax) {
        fail('sherd_dimension_invalid', `img_w 必须是 ${LIMITS.imgMin} ~ ${LIMITS.imgMax} 的整数`);
      }
      if (!isInt(sh.img_h) || sh.img_h < LIMITS.imgMin || sh.img_h > LIMITS.imgMax) {
        fail('sherd_dimension_invalid', `img_h 必须是 ${LIMITS.imgMin} ~ ${LIMITS.imgMax} 的整数`);
      }
      const scaleOk = validateScale(sh, fail);
      if (typeof sh.photo !== 'string' || !PHOTO_RE.test(sh.photo)) {
        fail('photo_path_invalid', 'photo 必须形如 photos/sherd-<ord>.jpg|.jpeg|.png|.webp');
      } else if (photoSet.has(sh.photo)) {
        fail('photo_duplicate', `照片路径重复：${sh.photo}`);
      } else {
        const photoOrd = parseInt(sh.photo.match(PHOTO_RE)[1], 10);
        if (isInt(sh.ord) && photoOrd !== sh.ord) {
          fail('photo_ord_mismatch', `照片文件名序号 ${photoOrd} 与陶片 ord=${sh.ord} 不一致`);
        }
        photoSet.add(sh.photo);
      }
      if (typeof sh.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sh.sha256)) {
        fail('photo_digest_invalid', '照片 sha256 必须是 64 位十六进制字符串');
      }
      if (sh.size_bytes !== undefined && sh.size_bytes !== null
        && (!isInt(sh.size_bytes) || sh.size_bytes < 0)) {
        fail('photo_size_invalid', 'size_bytes 必须是非负整数');
      }
      if (isInt(sh.ord) && sh.ord >= 1 && !ordToSherd.has(sh.ord)) {
        const normalized = {
          ord: sh.ord,
          label: typeof sh.label === 'string' ? sh.label : '',
          note: typeof sh.note === 'string' ? sh.note : '',
          img_w: isInt(sh.img_w) ? sh.img_w : null,
          img_h: isInt(sh.img_h) ? sh.img_h : null,
          scale_px: scaleOk ? sh.scale_px : null,
          scale_mm: scaleOk ? sh.scale_mm : null,
          photo: typeof sh.photo === 'string' ? sh.photo : null,
          sha256: typeof sh.sha256 === 'string' ? sh.sha256 : null,
          size_bytes: isInt(sh.size_bytes) ? sh.size_bytes : null,
        };
        ordToSherd.set(sh.ord, normalized);
        sherds.push(normalized);
      }
    });

    // ord 必须恰好为 1..n 连续排列（重映射本地 ID 的顺序依据）。
    // 条目本身非法（非对象等）时不计入 ord 集合，避免重复/缺失误报。
    if (manifest.sherds.length > 0 && ordSet.size === manifest.sherds.length) {
      for (let k = 1; k <= manifest.sherds.length; k++) {
        if (!ordSet.has(k)) push('sherd_ord_gap', `陶片 ord 不连续：缺少 ord=${k}`);
      }
    }
    sherds.sort((a, b) => a.ord - b.ord);
  }

  // ---- 5. 照片文件：缺失 / 重复（unzip 已拒重复条目）/ 摘要 / 魔数 ----
  const files = new Map();
  if (Array.isArray(manifest.sherds)) {
    for (const sh of sherds) {
      const where = sh.photo || `sherds[ord=${sh.ord}]`;
      const data = sh.photo ? entries.get(sh.photo) : undefined;
      if (data === undefined) {
        push('photo_missing', `清单声明的照片在包内缺失：${sh.photo}`, where);
        continue;
      }
      if (sh.sha256 && /^[a-f0-9]{64}$/.test(sh.sha256)) {
        const actual = sha256(data);
        if (actual !== sh.sha256) {
          push('photo_digest_mismatch',
            `照片 ${sh.photo} 的 SHA-256 与清单不符（照片可能被替换或损坏）`, where);
        }
        if (sh.size_bytes !== null && sh.size_bytes !== data.length) {
          push('photo_size_mismatch',
            `照片 ${sh.photo} 的字节数（${data.length}）与清单（${sh.size_bytes}）不符`, where);
        }
      }
      const sniffer = sniffImageType(data);
      const extType = PHOTO_RE.test(sh.photo)
        ? (sh.photo.match(PHOTO_RE)[2].toLowerCase() === 'jpg' ? 'jpeg' : sh.photo.match(PHOTO_RE)[2].toLowerCase())
        : null;
      if (!sniffer) {
        push('photo_not_image', `照片 ${sh.photo} 不是有效的 JPEG/PNG/WebP 文件`, where);
      } else if (extType && sniffer !== extType) {
        push('photo_type_mismatch',
          `照片 ${sh.photo} 扩展名（${extType}）与真实格式（${sniffer}）不符`, where);
      }
      files.set(sh.photo, data);
    }
    // 包内存在但清单未引用的照片
    for (const name of entries.keys()) {
      if (PHOTO_RE.test(name) && !photoSet.has(name)) {
        push('photo_unreferenced', `包内照片未被任何陶片引用：${name}`, name);
      }
    }
  }

  // ---- 6. 接缝（按采纳顺序；端点合法、比例尺、参数范围） ----
  const seams = [];
  const seamOrdSet = new Set();
  if (!Array.isArray(manifest.seams)) {
    push('seams_invalid', '清单 seams 必须是数组');
  } else {
    manifest.seams.forEach((sm, i) => {
      const where = `seams[${i}]`;
      const fail = (code, msg) => push(code, msg, where);
      if (!sm || typeof sm !== 'object' || Array.isArray(sm)) {
        return fail('seam_invalid', '接缝条目必须是对象');
      }
      if (!isInt(sm.ord) || sm.ord < 1) fail('seam_ord_invalid', 'ord 必须是 ≥1 的整数');
      else if (seamOrdSet.has(sm.ord)) fail('seam_ord_duplicate', `接缝 ord=${sm.ord} 重复`);
      else seamOrdSet.add(sm.ord);
      let fromOrd = null, toOrd = null;
      if (!isInt(sm.from_ord) || sm.from_ord < 1) fail('seam_endpoint_invalid', 'from_ord 必须是 ≥1 的整数');
      else fromOrd = sm.from_ord;
      if (!isInt(sm.to_ord) || sm.to_ord < 1) fail('seam_endpoint_invalid', 'to_ord 必须是 ≥1 的整数');
      else toOrd = sm.to_ord;
      if (fromOrd !== null && toOrd !== null && fromOrd === toOrd) {
        fail('seam_same_endpoint', '接缝必须连接两片不同的陶片');
      }
      if (fromOrd !== null && !ordToSherd.has(fromOrd)) {
        fail('seam_endpoint_missing', `from_ord=${fromOrd} 在陶片清单中不存在`);
      }
      if (toOrd !== null && !ordToSherd.has(toOrd)) {
        fail('seam_endpoint_missing', `to_ord=${toOrd} 在陶片清单中不存在`);
      }
      if (fromOrd !== null && toOrd !== null && fromOrd !== toOrd
        && ordToSherd.has(fromOrd) && ordToSherd.has(toOrd)) {
        const a = ordToSherd.get(fromOrd);
        const b = ordToSherd.get(toOrd);
        if (a.scale_px === null || b.scale_px === null) {
          fail('seam_endpoint_unscaled', '接缝两端的陶片都必须已标记毫米比例尺');
        }
      }
      if (!isNum(sm.theta_deg) || sm.theta_deg < LIMITS.thetaMin || sm.theta_deg > LIMITS.thetaMax) {
        fail('seam_param_invalid', `theta_deg 必须是 ${LIMITS.thetaMin} ~ ${LIMITS.thetaMax} 的数字`);
      }
      for (const f of ['tx', 'ty']) {
        if (!isNum(sm[f]) || sm[f] < LIMITS.tMin || sm[f] > LIMITS.tMax) {
          fail('seam_param_invalid', `${f} 必须是 ${LIMITS.tMin} ~ ${LIMITS.tMax} 的数字`);
        }
      }
      if (typeof sm.join_note !== 'string') fail('seam_note_invalid', 'join_note 必须是字符串');
      else if (sm.join_note.length > LIMITS.noteMax) fail('seam_note_invalid', `join_note 过长（最多 ${LIMITS.noteMax} 字符）`);

      seams.push({
        ord: isInt(sm.ord) ? sm.ord : i + 1,
        from_ord: fromOrd,
        to_ord: toOrd,
        theta_deg: isNum(sm.theta_deg) ? sm.theta_deg : null,
        tx: isNum(sm.tx) ? sm.tx : null,
        ty: isNum(sm.ty) ? sm.ty : null,
        join_note: typeof sm.join_note === 'string' ? sm.join_note : '',
      });
    });
    // 接缝 ord 也必须恰好 1..m 连续（采纳顺序）；存在其他非法条目时不重复报缺口。
    if (manifest.seams.length > 0 && seamOrdSet.size === manifest.seams.length) {
      for (let k = 1; k <= manifest.seams.length; k++) {
        if (!seamOrdSet.has(k)) push('seam_ord_gap', `接缝 ord 不连续：缺少 ord=${k}`);
      }
    }
    seams.sort((a, b) => a.ord - b.ord);
  }

  // ---- 7. 导出时闭合环摘要（结构合法即可；是否超容差由服务器重算后定夺） ----
  const cc = manifest.cycle_check;
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) {
    push('cycle_check_invalid', '清单缺少 cycle_check 对象');
  } else {
    if (!isNum(cc.tolerance_mm)) {
      push('cycle_check_invalid', 'cycle_check.tolerance_mm 必须是数字');
    } else if (cc.tolerance_mm !== toleranceMm) {
      push('cycle_check_tolerance_mismatch',
        'cycle_check.tolerance_mm 与 project.tolerance_mm 不一致');
    }
    if (!Array.isArray(cc.rings)) {
      push('cycle_check_invalid', 'cycle_check.rings 必须是数组');
    } else {
      cc.rings.forEach((ring, i) => {
        const where = `cycle_check.rings[${i}]`;
        const fail = (code, msg) => push(code, msg, where);
        if (!ring || typeof ring !== 'object') return fail('cycle_ring_invalid', '闭合环摘要必须是对象');
        if (!isInt(ring.seam_ord) || !seamOrdSet.has(ring.seam_ord)) {
          fail('cycle_ring_seam_ord_invalid', 'seam_ord 必须指向一条已存在的接缝');
        }
        if (!isNum(ring.distance_mm) || ring.distance_mm < 0) {
          fail('cycle_ring_invalid', 'distance_mm 必须是非负数字');
        }
        if (!isNum(ring.rotation_deg) || ring.rotation_deg < 0) {
          fail('cycle_ring_invalid', 'rotation_deg 必须是非负数字');
        }
        if (typeof ring.within_tolerance !== 'boolean') {
          fail('cycle_ring_invalid', 'within_tolerance 必须是布尔值');
        }
        if (typeof ring.within_tolerance === 'boolean' && toleranceMm !== null
          && isNum(ring.distance_mm) && ring.within_tolerance !== (ring.distance_mm <= toleranceMm)) {
          fail('cycle_ring_summary_inconsistent',
            `闭合环摘要自相矛盾：distance_mm=${ring.distance_mm} 与 within_tolerance=${ring.within_tolerance} 不符`);
        }
      });
    }
  }

  if (issues.length) {
    throw new PackageError(`方案包校验发现 ${issues.length} 个问题，整包拒绝`, issues);
  }

  return { manifest, files, ordToSherd, sherds, seams, tolerance_mm: toleranceMm };
}

function validateScale(sh, fail) {
  const px = sh.scale_px;
  const mm = sh.scale_mm;
  const pxNull = px === null || px === undefined;
  const mmNull = mm === null || mm === undefined;
  if (pxNull !== mmNull) {
    fail('sherd_scale_invalid', 'scale_px 与 scale_mm 必须同时给出或同时为空');
    return false;
  }
  if (pxNull) return false; // 未标比例尺的陶片允许存在（但不能作接缝端点）
  if (!isNum(px) || px < LIMITS.scaleMin || px > LIMITS.scaleMax
    || !isNum(mm) || mm < LIMITS.scaleMin || mm > LIMITS.scaleMax) {
    fail('sherd_scale_invalid',
      `比例尺必须是 ${LIMITS.scaleMin} ~ ${LIMITS.scaleMax} 的数字（scale_px/scale_mm）`);
    return false;
  }
  return true;
}

module.exports = {
  PACKAGE_KIND,
  FORMAT_VERSION,
  MANIFEST_NAME,
  PHOTO_RE,
  LIMITS,
  CHECKLIST,
  PackageError,
  buildExportZip,
  parseImportPackage,
  sniffImageType,
  sha256,
};

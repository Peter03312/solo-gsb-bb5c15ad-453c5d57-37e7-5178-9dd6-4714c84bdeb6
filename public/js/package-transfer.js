// 方案移交包：首页导入弹窗。下载在工作台侧栏直接以链接方式发起（GET 另存）。
//
// 导入时：选择 .zip → 可选重命名 → 上传。服务器整包校验：
//   400 package_invalid 时把 issues[] 逐条列出（清单/参数/照片摘要/
//   缺失或重复文件/越界路径等）；422 时列出超容差闭合环与冲突链。
//   任一种失败都不会在服务器留下方案或照片。
import { api } from './api.js';
import { esc, openModal, toast } from './ui.js';

const ISSUE_TEXT = {
  zip_unreadable: 'ZIP 无法解压',
  manifest_missing: '缺少清单',
  manifest_invalid_json: '清单 JSON 损坏',
  manifest_invalid: '清单结构非法',
  kind_unknown: '包类型不被识别',
  format_version_invalid: '格式版本非法',
  format_version_unsupported: '格式版本不受支持',
  checklist_mismatch: '校验清单不符',
  project_invalid: '方案参数缺失',
  project_name_invalid: '方案名称非法',
  tolerance_invalid: '毫米容差非法',
  sherds_invalid: '陶片清单非法',
  sherd_invalid: '陶片条目非法',
  sherd_ord_invalid: '陶片序号非法',
  sherd_ord_duplicate: '陶片序号重复',
  sherd_ord_gap: '陶片序号不连续',
  sherd_label_invalid: '陶片名称非法',
  sherd_note_invalid: '陶片备注非法',
  sherd_dimension_invalid: '陶片图像尺寸非法',
  sherd_scale_invalid: '比例尺非法',
  photo_path_invalid: '照片路径非法',
  photo_duplicate: '照片重复声明',
  photo_ord_mismatch: '照片序号与陶片序号不一致',
  photo_digest_invalid: '照片摘要非法',
  photo_digest_mismatch: '照片摘要不匹配（文件被替换或损坏）',
  photo_size_invalid: '照片字节数字段非法',
  photo_size_mismatch: '照片字节数与清单不符',
  photo_missing: '包内缺失照片文件',
  photo_not_image: '文件不是有效图片',
  photo_type_mismatch: '照片扩展名与真实格式不符',
  photo_unreferenced: '存在未被引用的照片',
  seams_invalid: '接缝清单非法',
  seam_invalid: '接缝条目非法',
  seam_ord_invalid: '接缝序号非法',
  seam_ord_duplicate: '接缝序号重复',
  seam_ord_gap: '接缝序号不连续',
  seam_endpoint_invalid: '接缝端点非法',
  seam_endpoint_missing: '接缝端点陶片不存在',
  seam_same_endpoint: '接缝连接了同一片陶片',
  seam_endpoint_unscaled: '接缝端点未标比例尺',
  seam_param_invalid: '接缝参数非法',
  seam_note_invalid: '接缝说明非法',
  cycle_check_invalid: '闭合环校验摘要非法',
  cycle_check_tolerance_mismatch: '闭合环摘要容差与方案容差不一致',
  cycle_ring_invalid: '闭合环摘要条目非法',
  cycle_ring_seam_ord_invalid: '闭合环摘要指向不存在的接缝',
  cycle_ring_summary_inconsistent: '闭合环摘要自相矛盾',
  unexpected_file: '包内存在清单之外的文件',
  path_outside_package: '包内存在越界路径（已拦截）',
};

export function openImportPackage({ onImported }) {
  const { body, close } = openModal({ title: '📦 导入方案包（.zip）' });
  body.innerHTML = `
    <p class="align-hint">
      导入会在本工作台创建一个<b>独立的新方案</b>：陶片与接缝都会重新分配本地 ID，
      接缝按包内采纳顺序关联、布局与闭合环结果与源方案等价。
      服务器会整包校验清单、毫米容差、照片摘要、缺失/重复文件、越界路径以及全部闭合环；
      任一不合法都会整包拒绝，不会留下方案或孤儿照片。
    </p>
    <div class="row">
      <label class="field">方案包 ZIP
        <input type="file" id="imp-file" accept=".zip,application/zip" />
      </label>
    </div>
    <div class="row">
      <label class="field">新方案名称（可选，默认沿用包内名称）
        <input type="text" id="imp-name" maxlength="200" placeholder="留空则使用包内方案名" />
      </label>
    </div>
    <div class="actions">
      <button class="secondary" id="imp-cancel">取消</button>
      <button id="imp-submit" disabled>导入</button>
    </div>
    <div id="imp-status" class="kv" style="margin-top:8px"></div>`;

  const fileEl = body.querySelector('#imp-file');
  const nameEl = body.querySelector('#imp-name');
  const submit = body.querySelector('#imp-submit');
  const status = body.querySelector('#imp-status');
  let chosen = null;

  fileEl.onchange = () => {
    chosen = fileEl.files[0] || null;
    submit.disabled = !chosen;
    if (chosen) status.textContent = `已选择：${chosen.name}（${(chosen.size / 1024 / 1024).toFixed(2)} MB）`;
  };
  body.querySelector('#imp-cancel').onclick = close;

  submit.onclick = async () => {
    if (!chosen) return;
    submit.disabled = true;
    status.innerHTML = '<span class="kv">正在上传并整包校验…</span>';
    try {
      const state = await api.importPackage(chosen, nameEl.value.trim());
      close();
      toast(`已导入为独立方案「${state.project.name}」：${state.imported ? state.source.sherd_count : state.sherds.length} 片陶片、${state.seams.length} 条接缝`, 'success');
      onImported(state);
    } catch (e) {
      submit.disabled = false;
      renderImportError(status, e);
    }
  };
}

function renderImportError(host, err) {
  const error = err.data && err.data.error;
  if (err.status === 400 && error && Array.isArray(error.issues) && error.issues.length) {
    const grouped = new Map();
    for (const issue of error.issues) {
      const key = issue.where || '';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(issue);
    }
    const blocks = [...grouped.entries()].map(([where, list]) => `
      <div style="margin-top:6px">
        ${where ? `<b>${esc(where)}</b><br/>` : ''}
        ${list.map((i) => {
          const tag = ISSUE_TEXT[i.code] || i.code;
          return `· <span>${esc(tag)}</span>${i.message && i.message !== tag ? ` <span class="kv">${esc(i.message.replace(/^[^：:]*[：:]/, ''))}</span>` : ''}`;
        }).join('<br/>')}
      </div>`).join('');
    host.innerHTML = `
      <div class="conflict-box">
        <div><b>🚫 整包拒绝（${error.issues.length} 个问题）：${esc(error.message || '方案包不合法')}</b></div>
        ${blocks}
        <div class="kv" style="margin-top:6px">未创建任何方案，也没有照片被保留。请修正后重新选择文件导入。</div>
      </div>`;
    return;
  }
  if (err.status === 422 && error && error.reason === 'import_cycle_tolerance_exceeded') {
    const rows = (error.violations || []).map((v) => `
      <div style="margin-top:6px">
        <b>接缝 #${v.seam_ord}（陶片 ${v.from_ord}→${v.to_ord}）</b>：
        闭合偏差 ${v.deviation_mm} mm / ${v.rotation_deg}°，超过容差 ${v.tolerance_mm} mm。
        ${v.conflict_chain ? `<div class="kv" style="margin-left:10px">
          冲突链：${v.conflict_chain.sherds.map((s) => `陶片${s.ord}`).join(' → ')}，
          沿接缝 ${v.conflict_chain.seams.map((s) => `#${s.seam_ord}`).join(' → ')}，
          由接缝 #${v.conflict_chain.closing_seam.seam_ord} 闭合。
        </div>` : ''}
      </div>`).join('');
    host.innerHTML = `
      <div class="conflict-box">
        <div><b>🚫 ${esc(error.message || '闭合环超容差，整包拒绝')}</b></div>
        ${rows}
        <div class="kv" style="margin-top:6px">未创建任何方案，也没有照片被保留。</div>
      </div>`;
    return;
  }
  host.innerHTML = `<div class="conflict-box">导入失败：${esc(err.message)}</div>`;
}

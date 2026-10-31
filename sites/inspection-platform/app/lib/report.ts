import { REVIEW_LABELS, type InspectionBox, type InspectionRecord } from './types';
import { QUALITY_METHOD, QUALITY_THRESHOLDS } from './quality';
import { clearDisplayOverlay } from './display-review';

const BOX_COLORS: Record<InspectionBox['label'], string> = {
  pending: '#e09a12', scratch: '#d73748', 'normal-hole': '#17845a', joint: '#207a9d', shadow: '#8a58b4', uncertain: '#ad641f',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function safeImageUrl(value: string): string {
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
  const url = new URL(value, window.location.href);
  if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
  throw new Error('图片地址格式不受支持，请重新上传图片。');
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const src = safeImageUrl(url);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => reject(new Error('图片读取超时，请检查网络后重新导出。')), 20000);
    image.onload = () => { window.clearTimeout(timer); resolve(image); };
    image.onerror = () => { window.clearTimeout(timer); reject(new Error('无法读取报告图片，请重新上传或检查图片访问权限。')); };
    image.src = src;
  });
}

function rectangle(box: InspectionBox, width: number, height: number) {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return null;
  const x = Math.max(0, Math.min(width, box.x * width));
  const y = Math.max(0, Math.min(height, box.y * height));
  const right = Math.max(0, Math.min(width, (box.x + box.w) * width));
  const bottom = Math.max(0, Math.min(height, (box.y + box.h) * height));
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成结果图。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

function annotatedImage(record: InspectionRecord, image: HTMLImageElement): string {
  const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
  const { canvas, context } = createCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const paired = record.imageRole === 'paired-display' || record.captureMetadata?.captureKind === 'paired-display';
  if (paired && record.boxes.some(box => box.origin === 'fpga')) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    pixels.data.set(clearDisplayOverlay(pixels.data, canvas.width, canvas.height, record.boxes));
    context.putImageData(pixels, 0, 0);
  }
  const fontSize = Math.max(14, Math.round(Math.max(canvas.width, canvas.height) / 65));
  context.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
  context.lineWidth = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 500));
  record.boxes.filter(box => !box.removed).forEach((box, index) => {
    const rect = rectangle(box, canvas.width, canvas.height);
    if (!rect) return;
    const color = BOX_COLORS[box.label] ?? '#e09a12';
    context.strokeStyle = color;
    context.strokeRect(rect.x, rect.y, rect.w, rect.h);
    const label = `${index + 1} · ${REVIEW_LABELS[box.label] ?? '待复核'}`;
    const labelWidth = Math.min(canvas.width, context.measureText(label).width + 16);
    const labelHeight = fontSize + 12;
    const labelX = Math.max(0, Math.min(rect.x, canvas.width - labelWidth));
    const labelY = Math.max(0, Math.min(rect.y >= labelHeight ? rect.y - labelHeight : rect.y, canvas.height - labelHeight));
    context.fillStyle = color;
    context.fillRect(labelX, labelY, labelWidth, labelHeight);
    context.fillStyle = '#ffffff';
    context.fillText(label, labelX + 8, labelY + fontSize + 2, labelWidth - 12);
  });
  if (record.isDemo || record.source === 'demo') {
    const label = '人工示例 · 非设备实测';
    const margin = Math.max(8, fontSize / 2);
    const labelWidth = Math.min(canvas.width, context.measureText(label).width + margin * 2);
    context.fillStyle = 'rgba(14, 26, 34, 0.86)';
    context.fillRect(0, canvas.height - fontSize - margin * 2, labelWidth, fontSize + margin * 2);
    context.fillStyle = '#ffffff';
    context.fillText(label, margin, canvas.height - margin, Math.max(1, labelWidth - margin * 2));
  }
  return canvas.toDataURL('image/png');
}

/** Draws the current review boxes; this does not execute defect detection. */
export async function generateAnnotatedImage(record: InspectionRecord): Promise<string> {
  const image = await loadImage(record.imageUrl);
  try {
    return annotatedImage(record, image);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') throw new Error('图片来源不允许导出，请先导入本地图片。');
    throw error;
  }
}

function cropImage(box: InspectionBox, image: HTMLImageElement): string | null {
  const rect = rectangle(box, image.naturalWidth, image.naturalHeight);
  if (!rect) return null;
  const scale = Math.min(1, 1024 / Math.max(rect.w, rect.h));
  const { canvas, context } = createCanvas(rect.w * scale, rect.h * scale);
  context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function labelText(label: InspectionBox['label']): string {
  return REVIEW_LABELS[label] ?? '待复核';
}

function formatNumber(value: number, places = 1): string {
  return Number.isFinite(value) ? value.toFixed(places) : '未记录';
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

export function reportHtml(record: InspectionRecord, annotated: string, crops: Array<string | null>): string {
  const e = escapeHtml;
  const isDemo = record.isDemo || record.source === 'demo';
  const paired = record.imageRole === 'paired-display' || record.captureMetadata?.captureKind === 'paired-display';
  const imageLabel = paired ? '检测截图' : '原图';
  const imageCaption = paired ? '设备检测截图' : record.source === 'fpga' ? '设备原图' : '上传原图';
  const source = isDemo ? '人工示例（非设备实测）' : record.source === 'fpga' ? '导入的 FPGA 结果' : '人工上传';
  const ai = record.ai;
  const aiStatus = !ai ? '尚未分析' : ai.status === 'unconfigured' ? '未配置' : ai.status === 'error' ? '分析失败' : '已生成辅助建议';
  const qualityMeasured = record.quality.measured !== false;
  const qualityStatus = qualityMeasured ? ({ good: '采集质量参考：正常', review: '建议人工复核图像', retake: '建议调整采集条件后重拍' }[record.quality.verdict] ?? '未记录') : '拍摄质量未测量';
  const fig = (url: string, caption: string) => `<figure><img src="${e(safeImageUrl(url))}" alt="${e(caption)}"><figcaption>${e(caption)}</figcaption></figure>`;
  // In paired-display mode imageUrl and resultImageUrl represent the same
  // immutable device screenshot, not two independent evidence images.
  const outputImage = !paired && record.resultImageUrl ? fig(record.resultImageUrl, '设备结果图（按原文件保存）') : '';
  const edgeImage = !paired && record.edgeImageUrl ? fig(record.edgeImageUrl, '边缘参考图（按原文件保存）') : '';
  const scratchCount = record.captureMetadata?.scratchCount;
  const activeBoxes = record.boxes.filter(box => !box.removed);
  const removedBoxes = record.boxes.filter(box => box.removed);
  const confirmedCount = activeBoxes.filter(box => box.label === 'scratch').length;
  const pendingCount = activeBoxes.filter(box => box.label === 'pending').length;
  const captureNote = paired ? `<p class="fine">设备回传为拼接检测截图，不含独立无框原图或独立边缘图。${typeof scratchCount === 'number' && Number.isInteger(scratchCount) ? `设备原始上报候选 ${e(scratchCount)} 处，人工复核数量另列。` : ''}</p><p class="fine">人工复核预览，框线处作显示处理；原始检测截图另保留。</p>` : '';
  const qualityMetrics = qualityMeasured ? `<div class="metrics"><div class="metric"><strong>${e(formatNumber(record.quality.brightness))}</strong><span>平均亮度 / 255</span></div><div class="metric"><strong>${e(formatNumber(record.quality.darkRatio * 100))}%</strong><span>暗部比例</span></div><div class="metric"><strong>${e(formatNumber(record.quality.brightRatio * 100))}%</strong><span>亮部比例</span></div><div class="metric"><strong>${e(formatNumber(record.quality.sharpness))}</strong><span>拉普拉斯方差</span></div></div>` : '';
  const cropsHtml = activeBoxes.map((box, index) => `<article class="crop-card">
    <h3>区域 ${index + 1} · ${e(labelText(box.label))}</h3>
    ${crops[index] ? `<img src="${e(crops[index])}" alt="区域 ${index + 1} ${imageLabel}局部">` : '<p class="muted">区域坐标无效，无法生成局部图。</p>'}
    <p class="muted">标注来源：${e(box.origin === 'example' ? '人工示例' : box.origin === 'fpga' ? paired ? '截图红框提取' : '导入 FPGA 框' : '人工框选')}</p>
    <p>${e(box.note || '未填写区域备注')}</p>
  </article>`).join('');
  const removedHtml = removedBoxes.length ? `<h2>已移除区域</h2><p class="fine">以下区域已被人工排除，不计入当前划痕或待复核数量。原始截图与区域坐标保留。</p><ul>${removedBoxes.map(box => `<li>区域 ${e(box.id)} · 移除前标签：${e(labelText(box.label))}${box.note ? ` · ${e(box.note)}` : ''}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'">
  <title>${e(record.partId || record.filename)} · 零件检测复核报告</title>
  <style>
  *{box-sizing:border-box}body{margin:0;background:#eef2f4;color:#172a35;font:14px/1.65 "Microsoft YaHei", "PingFang SC",sans-serif}main{max-width:1080px;margin:30px auto;padding:44px;background:white}h1{font-size:28px;line-height:1.3;margin:8px 0}h2{font-size:18px;margin:28px 0 12px;padding-bottom:8px;border-bottom:1px solid #d9e3e8}h3{font-size:15px;margin:0 0 12px}.eyebrow{color:#167964;letter-spacing:2px;font-size:12px;font-weight:700}.muted{color:#677985}.toolbar{position:sticky;top:0;background:#102c38;color:#fff;padding:12px 22px;display:flex;justify-content:space-between;align-items:center;gap:20px}.toolbar button{border:0;border-radius:6px;background:#67dfbd;color:#12362d;padding:10px 18px;font-weight:700;cursor:pointer}.notice{padding:12px 16px;background:#fff4d9;border:1px solid #f0d49b;border-radius:6px;margin:18px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;padding:18px;background:#f4f8fa;border-radius:8px}.meta p{margin:0;overflow-wrap:anywhere}.key{color:#677985;margin-right:10px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{padding:14px;background:#f4f8fa;border-radius:6px}.metric strong{display:block;font-size:24px}.metric span{font-size:12px;color:#677985}figure{margin:0;break-inside:avoid}figure img{display:block;width:100%;height:300px;object-fit:contain;background:#f4f6f7;border:1px solid #dfe6e9}figcaption{font-size:12px;color:#677985;margin-top:6px}p{white-space:pre-wrap;overflow-wrap:anywhere}.crop-card{padding:16px;border:1px solid #dfe6e9;border-radius:6px;break-inside:avoid}.crop-card img{width:100%;height:180px;object-fit:contain;background:#f4f6f7}.crop-card p{font-size:12px;margin:8px 0 0}.statement{padding:18px;border-left:3px solid #168a70;background:#f0f8f5}.fine{font-size:11px;color:#677985}li{overflow-wrap:anywhere}footer{margin-top:32px;padding-top:14px;border-top:1px solid #d9e3e8;font-size:11px;color:#677985}
  @page{size:A4;margin:14mm}@media print{body{background:white;font-size:10pt}main{max-width:none;margin:0;padding:0}.toolbar{display:none}h1{font-size:24pt}h2{font-size:14pt;break-after:avoid}figure img{height:65mm}.crop-card img{height:43mm}.meta{font-size:9pt}.metrics{gap:7px}.metric strong{font-size:20pt}.notice,.statement,.meta,.metrics{break-inside:avoid}a{color:inherit}}@media(max-width:700px){main{margin:0;padding:24px}.grid,.meta{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.toolbar{font-size:12px}}
  </style></head><body>
  <div class="toolbar"><button id="print-report" type="button">打印 / 保存为 PDF</button></div>
  <main><h1>零件检测复核报告</h1>
  ${isDemo ? '<div class="notice"><strong>人工示例 · 非设备实测</strong><br>本记录用于演示页面流程，示例标注与结果不代表真实检测性能。</div>' : ''}
  <div class="meta"><p><span class="key">零件编号</span>${e(record.partId || '未填写')}</p><p><span class="key">批次编号</span>${e(record.batchId || '未填写')}</p><p><span class="key">归档时间</span>${e(timeLabel(record.createdAt))}（UTC+8）</p><p><span class="key">记录来源</span>${e(source)}</p><p><span class="key">文件名称</span>${e(record.filename)}</p><p><span class="key">${imageLabel}尺寸</span>${e(record.width)} × ${e(record.height)} 像素</p><p><span class="key">记录编号</span>${e(record.id)}</p><p><span class="key">记录版本</span>${e(record.revision)}</p></div>
  <h2>人工复核</h2><div class="statement"><strong>${e(labelText(record.review.label))}</strong><p>${e(record.review.note || '尚未填写复核备注。')}</p></div><p class="fine">当前区域 ${activeBoxes.length} 个 · 已确认划痕 ${confirmedCount} 个 · 待复核 ${pendingCount} 个 · 已移除 ${removedBoxes.length} 个。区域数量不是零件数量，报告保留当前人工结论。</p>
  <h2>${imageLabel}与标注结果</h2>${captureNote}<div class="grid">${fig(record.imageUrl, imageCaption)}${fig(annotated, paired ? '人工复核预览（框线作显示处理）' : '当前区域标注')}${outputImage}${edgeImage}</div>
  <h2>局部区域</h2>${cropsHtml ? `<div class="grid">${cropsHtml}</div>` : '<p class="muted">尚无区域标注。</p>'}
  ${removedHtml}
  <h2>图像质量参考</h2><p><strong>${e(qualityStatus)}</strong></p>${qualityMetrics}
  ${record.quality.warnings.length ? `<ul>${record.quality.warnings.map(warning => `<li>${e(warning)}</li>`).join('')}</ul>` : qualityMeasured ? '<p class="muted">未触发预设质量提醒，仍需人工检查图像。</p>' : '<p class="muted">请人工检查曝光、清晰度和反光。</p>'}
  ${qualityMeasured ? `<p class="fine">${e(QUALITY_METHOD)}平均亮度低于 ${QUALITY_THRESHOLDS.meanDarkBelow} 或高于 ${QUALITY_THRESHOLDS.meanBrightAbove} 也提示复核；暗部超过 70% 且平均亮度低于 45，或亮部超过 85% 且平均亮度高于 235，建议重拍。</p>` : ''}
  <h2>AI 辅助建议</h2><p><strong>${e(aiStatus)}</strong></p>${ai ? `<p>${e(ai.summary)}</p>${ai.observations?.length ? `<ul>${ai.observations.map(observation => `<li>${e(observation)}</li>`).join('')}</ul>` : ''}${ai.recommendation ? `<p><strong>建议：</strong>${e(ai.recommendation)}</p>` : ''}${ai.model ? `<p class="fine">模型：${e(ai.model)}${ai.analyzedAt ? ` · 分析时间：${e(timeLabel(ai.analyzedAt))}（UTC+8）` : ''}</p>` : ''}` : ''}
  <p class="fine">AI 建议用于辅助人工复核，不替代 FPGA 实测结果或人工检验。</p>
  <footer>生成时间：${e(timeLabel(new Date().toISOString()))}（UTC+8） · 浏览器打印报告。图像质量指标为启发式参考，检测结论以实际来源和人工复核为准。</footer>
  </main></body></html>`;
}

/** Opens a real print preview. The user can choose the browser's Save as PDF option. */
export async function exportReport(record: InspectionRecord): Promise<void> {
  // Open before awaiting image work, so a user click remains the popup's activation.
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('浏览器拦截了报告窗口，请允许弹出窗口后重试。');
  popup.opener = null;
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>准备报告</title><body style="font-family:sans-serif;padding:40px"><p>正在生成图像与报告，请稍候…</p></body></html>');
  popup.document.close();
  try {
    const image = await loadImage(record.imageUrl);
    const annotated = annotatedImage(record, image);
    const crops = record.boxes.filter(box => !box.removed).map(box => cropImage(box, image));
    const html = reportHtml(record, annotated, crops);
    if (popup.closed) throw new Error('报告窗口已关闭，请重新导出。');
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.document.getElementById('print-report')?.addEventListener('click', () => popup.print());
    await Promise.all(Array.from(popup.document.images).map(img => new Promise<void>(resolve => {
      if (img.complete) { resolve(); return; }
      const timer = window.setTimeout(resolve, 12000);
      const done = () => { window.clearTimeout(timer); resolve(); };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    })));
    if (!popup.closed) {
      popup.focus();
      popup.print();
    }
  } catch (error) {
    if (!popup.closed) {
      popup.document.open();
      popup.document.write(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>报告生成未完成</title><body style="font-family:sans-serif;padding:40px"><h1>报告生成未完成</h1><p>${escapeHtml(error instanceof Error ? error.message : '请检查图片后重试。')}</p></body></html>`);
      popup.document.close();
    }
    throw error;
  }
}

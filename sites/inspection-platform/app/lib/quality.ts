import type { QualityMetrics } from './types';

/** Public, heuristic capture checks. None of these thresholds identifies a defect. */
export const QUALITY_THRESHOLDS = Object.freeze({
  maxSampleDimension: 640,
  darkPixelBelow: 25,
  brightPixelAbove: 245,
  meanDarkBelow: 55,
  meanBrightAbove: 215,
  darkAreaReviewAbove: 0.35,
  brightAreaReviewAbove: 0.25,
  darkAreaRetakeAbove: 0.7,
  brightAreaRetakeAbove: 0.85,
  darkMeanRetakeBelow: 45,
  brightMeanRetakeAbove: 235,
  laplacianVarianceReviewBelow: 60,
});

export const QUALITY_METHOD = '最长边缩放至 640 像素后，按亮度 Y=0.2126R+0.7152G+0.0722B 计算。暗部为 Y<25，亮部为 Y>245；暗部超过 35% 或亮部超过 25% 时提示复核。清晰度为拉普拉斯方差，低于 60 时仅提醒检查对焦，不单凭此值要求重拍。金属高光与平滑背景会影响指标，指标不用于识别划痕或判定零件合格。';

/** Separated from Canvas so the actual pixel calculations can be tested. */
export function analyzeRgbaPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): QualityMetrics {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error('无法分析图像：像素尺寸或数据不完整。');
  }

  const count = width * height;
  const luminance = new Float64Array(count);
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const alpha = rgba[at + 3] / 255;
    // Match the browser's white capture background for transparent images.
    const y = (0.2126 * rgba[at] + 0.7152 * rgba[at + 1] + 0.0722 * rgba[at + 2]) * alpha + 255 * (1 - alpha);
    luminance[i] = y;
    sum += y;
    if (y < QUALITY_THRESHOLDS.darkPixelBelow) dark++;
    if (y > QUALITY_THRESHOLDS.brightPixelAbove) bright++;
  }

  let lapSum = 0;
  let lapSquared = 0;
  let lapCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = luminance[i - width] + luminance[i + width] + luminance[i - 1] + luminance[i + 1] - 4 * luminance[i];
      lapSum += lap;
      lapSquared += lap * lap;
      lapCount++;
    }
  }

  const brightness = sum / count;
  const darkRatio = dark / count;
  const brightRatio = bright / count;
  const sharpness = lapCount ? Math.max(0, lapSquared / lapCount - (lapSum / lapCount) ** 2) : 0;
  const warnings: string[] = [];
  let verdict: QualityMetrics['verdict'] = 'good';

  if (brightness < QUALITY_THRESHOLDS.meanDarkBelow || darkRatio > QUALITY_THRESHOLDS.darkAreaReviewAbove) {
    warnings.push('暗部较多，请检查照明和曝光，确认表面细节可辨。');
  }
  if (brightness > QUALITY_THRESHOLDS.meanBrightAbove || brightRatio > QUALITY_THRESHOLDS.brightAreaReviewAbove) {
    warnings.push('亮部较多，请检查反光与过曝；金属高光本身不代表缺陷。');
  }
  if (width < 3 || height < 3) {
    warnings.push('图像尺寸过小，无法可靠估计清晰度。');
  } else if (sharpness < QUALITY_THRESHOLDS.laplacianVarianceReviewBelow) {
    warnings.push('清晰度指标偏低，请人工检查对焦；平滑表面也可能得到较低数值。');
  }
  if (warnings.length) verdict = 'review';
  if (
    (darkRatio > QUALITY_THRESHOLDS.darkAreaRetakeAbove && brightness < QUALITY_THRESHOLDS.darkMeanRetakeBelow) ||
    (brightRatio > QUALITY_THRESHOLDS.brightAreaRetakeAbove && brightness > QUALITY_THRESHOLDS.brightMeanRetakeAbove)
  ) {
    verdict = 'retake';
    warnings.unshift('画面大面积偏暗或偏亮，建议调整采集条件后重拍；这是采集质量建议。');
  }

  return {
    brightness: Math.round(brightness * 10) / 10,
    darkRatio,
    brightRatio,
    sharpness: Math.round(sharpness * 10) / 10,
    warnings,
    verdict,
  };
}

/** The caller must wait until the image has loaded. */
export function analyzeImageQuality(image: HTMLImageElement): QualityMetrics {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
    throw new Error('图像尚未加载完成，请稍后再检查质量。');
  }
  const scale = Math.min(1, QUALITY_THRESHOLDS.maxSampleDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法读取图像像素，请换用支持 Canvas 的浏览器。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    return analyzeRgbaPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') {
      throw new Error('图片来源不允许读取像素，请上传本地图片后重试。');
    }
    throw error;
  }
}

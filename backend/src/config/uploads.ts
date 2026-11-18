export const DEFAULT_MAX_UPLOAD_BYTES = 524288000;

export function getMaxUploadBytes() {
  const configured = Number(process.env.MAX_UPLOAD_SIZE_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

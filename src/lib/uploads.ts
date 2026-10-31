export const ALLOWED_UPLOAD_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export const ALLOWED_UPLOAD_TYPE_SET = new Set<string>(ALLOWED_UPLOAD_TYPES);

// Mirrors ALLOWED_UPLOAD_TYPES so the picker hides unsupported files instead of
// letting the server reject them after the user waits for an upload.
export const UPLOAD_ACCEPT = [
  ".pdf",
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".zip",
  ".docx",
].join(",");

const TYPE_BADGES: Record<string, string> = {
  "application/pdf": "PDF",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/webp": "WEBP",
  "application/zip": "ZIP",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

export function typeBadge(contentType: string, fileName: string) {
  const known = TYPE_BADGES[contentType];
  if (known) return known;
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
  return (extension || "FILE").slice(0, 4).toUpperCase();
}

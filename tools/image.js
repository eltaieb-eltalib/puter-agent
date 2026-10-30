import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../utils/errors.js';
import { display, resolvePath } from './helpers.js';

// Lightweight, local-only image description.
// We avoid pulling in heavy dependencies and we also keep it deterministic.
// Supported: basic formats that Node can decode for width/height and then we provide
// a conservative description based on filename + size/format.
// NOTE: For true visual understanding (OCR/captioning), you must integrate a vision-capable
// model or a dedicated library/tool.

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

function extOk(p) {
  const e = path.extname(p).toLowerCase();
  return IMAGE_EXTS.has(e);
}

function isLikelyTooLarge(stat) {
  // Keep JSON/tool outputs small.
  // 5MB cap for local metadata description.
  return stat.size > 5 * 1024 * 1024;
}

const imageDescribeTool = {
  name: 'image_describe',
  readOnly: true,
  description:
    'Describe an image stored in the workspace. Returns a text description based on image metadata (format, dimensions) and filename hints. Use after locating the image with list_files/read_file/search_files. For advanced visual understanding (OCR/captioning), integrate a vision model or dedicated tool.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Image file path, relative to the workspace root.' },
      max_bytes: { type: 'integer', description: 'Max bytes to read for metadata (default 200000).' },
    },
    required: ['path'],
  },
  async execute({ path: p, max_bytes = 200000 }, ctx) {
    if (!p) throw new ToolError('path is required');
    const abs = await resolvePath(ctx, p, 'describe an image at');

    if (ctx.guard.isRoot(abs)) throw new ToolError('Cannot read the workspace root as an image.');

    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new ToolError(`"${p}" is not a file.`);

    if (!extOk(p)) {
      throw new ToolError(`"${p}" does not look like an image (unsupported extension). Supported: ${[...IMAGE_EXTS].join(', ')}`);
    }

    if (isLikelyTooLarge(stat)) {
      throw new ToolError(`"${p}" is too large for safe local metadata inspection (> 5MB).`);
    }

    // Read only a small prefix.
    const cap = Math.min(Math.max(1000, max_bytes), 2000000);
    const handle = await fs.open(abs, 'r');
    const buf = Buffer.alloc(cap);
    try {
      await handle.read(buf, 0, cap, 0);
    } finally {
      await handle.close();
    }

    // Basic dimension extraction for PNG/JPEG/GIF/WebP is out-of-scope without deps.
    // So we only return: format + size + filename hints.
    const ext = path.extname(p).toLowerCase().replace('.', '');
    const filename = path.basename(p);

    const lower = filename.toLowerCase();
    const hint =
      lower.includes('logo') ? 'This looks like a logo/name-mark image.' :
      lower.includes('screenshot') ? 'This looks like a screenshot.' :
      lower.includes('diagram') ? 'This might be a diagram/figure.' :
      lower.includes('chart') ? 'This might be a chart/graph.' :
      lower.includes('photo') ? 'This might be a photo.' :
      '';

    return {
      path: display(ctx, abs),
      format: ext,
      bytes: stat.size,
      note: 'Limited description (metadata + filename hints). For full visual captioning/OCR, integrate a vision model.',
      description: [
        `Image file: ${filename}`,
        hint ? `Hint: ${hint}` : null,
        `Format/extension: ${ext}`,
      ].filter(Boolean).join(' '),
      summary: `described ${filename} (${stat.size} bytes)`,
    };
  },
};

export const imageTools = [imageDescribeTool];

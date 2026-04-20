const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function buildModelDataUrl(filePath, options) {
  const {
    imageWidthForModel,
    jpegQualityForModel,
  } = options || {};

  if (!filePath) {
    throw new Error('buildModelDataUrl requires filePath');
  }

  if (!Number.isInteger(imageWidthForModel) || imageWidthForModel < 64) {
    throw new Error('buildModelDataUrl requires imageWidthForModel >= 64');
  }

  if (!Number.isInteger(jpegQualityForModel) || jpegQualityForModel < 1 || jpegQualityForModel > 100) {
    throw new Error('buildModelDataUrl requires jpegQualityForModel between 1 and 100');
  }

  const absolutePath = path.resolve(filePath);
  await assertReadableFile(absolutePath);

  let originalMetadata;
  let outputBuffer;
  let outputMetadata;

  try {
    const pipeline = sharp(absolutePath, { failOn: 'warning' });
    originalMetadata = await pipeline.metadata();

    outputBuffer = await sharp(absolutePath, { failOn: 'warning' })
      .rotate()
      .resize({
        width: imageWidthForModel,
        withoutEnlargement: true,
        fit: 'inside',
      })
      .jpeg({
        quality: jpegQualityForModel,
        mozjpeg: true,
        chromaSubsampling: '4:2:0',
      })
      .toBuffer();

    outputMetadata = await sharp(outputBuffer).metadata();
  } catch (error) {
    throw new Error(`Failed to prepare image for model: ${absolutePath}. ${error.message}`);
  }

  return {
    sourcePath: absolutePath,
    mimeType: 'image/jpeg',
    dataUrl: toDataUrl(outputBuffer, 'image/jpeg'),
    bytes: outputBuffer.length,
    width: outputMetadata.width || null,
    height: outputMetadata.height || null,
    originalWidth: originalMetadata && originalMetadata.width ? originalMetadata.width : null,
    originalHeight: originalMetadata && originalMetadata.height ? originalMetadata.height : null,
    originalFormat: originalMetadata && originalMetadata.format ? originalMetadata.format : null,
  };
}

async function assertReadableFile(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    throw new Error(`File not found or unreadable: ${filePath}. ${error.message}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
}

function toDataUrl(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('toDataUrl requires a non-empty buffer');
  }
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

module.exports = {
  buildModelDataUrl,
  toDataUrl,
};

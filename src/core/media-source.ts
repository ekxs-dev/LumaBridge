import { parseMatroska } from './matroska';
import { parseMp4, type Mp4ParseResult } from './mp4';

export type MediaContainer = 'mp4' | 'matroska';

export interface ParsedMediaSource extends Mp4ParseResult {
  container: MediaContainer;
  bytes: Uint8Array;
  loadedBytes: number;
  isPartial: boolean;
  warning: string | null;
}

export const DEFAULT_CONTAINER_PREFIX_BYTES = 16 * 1024 * 1024;

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if ('arrayBuffer' in blob && typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('FileReader did not return an ArrayBuffer.'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('FileReader failed.')));
    reader.readAsArrayBuffer(blob);
  });
}

export function isLikelyMatroskaFile(file: Pick<File, 'name' | 'type'>): boolean {
  const name = file.name.toLowerCase();
  return file.type === 'video/matroska' || file.type === 'video/x-matroska' || name.endsWith('.mkv') || name.endsWith('.mk3d');
}

export function isLikelyMp4File(file: Pick<File, 'name' | 'type'>): boolean {
  const name = file.name.toLowerCase();
  return file.type === 'video/mp4' || name.endsWith('.mp4') || name.endsWith('.m4v') || name.endsWith('.mov');
}

export function hasEbmlHeader(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

async function readFilePrefix(file: File, maxBytes: number): Promise<Uint8Array> {
  const slice = file.slice(0, Math.min(file.size, maxBytes));
  return new Uint8Array(await blobToArrayBuffer(slice));
}

async function readWholeFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await blobToArrayBuffer(file));
}

function withSource(result: Mp4ParseResult, container: MediaContainer, bytes: Uint8Array, fileSize: number, warning: string | null): ParsedMediaSource {
  return {
    ...result,
    container,
    bytes,
    loadedBytes: bytes.byteLength,
    isPartial: bytes.byteLength < fileSize,
    warning,
  };
}

export async function parseMediaFile(file: File, prefixBytes = DEFAULT_CONTAINER_PREFIX_BYTES): Promise<ParsedMediaSource> {
  const prefix = await readFilePrefix(file, prefixBytes);

  if (isLikelyMatroskaFile(file) || hasEbmlHeader(prefix)) {
    return withSource(parseMatroska(prefix), 'matroska', prefix, file.size, prefix.byteLength < file.size ? 'Matroska parsed from a prefix window.' : null);
  }

  const bytes = prefix.byteLength === file.size ? prefix : await readWholeFile(file);
  try {
    return withSource(parseMp4(bytes), 'mp4', bytes, file.size, null);
  } catch (mp4Error) {
    if (hasEbmlHeader(prefix)) {
      return withSource(parseMatroska(prefix), 'matroska', prefix, file.size, prefix.byteLength < file.size ? 'Matroska parsed after MP4 parse failed.' : null);
    }
    throw mp4Error;
  }
}

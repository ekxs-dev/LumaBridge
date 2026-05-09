export type LumaErrorCode =
  | 'WEBGPU_UNAVAILABLE'
  | 'WEBCODECS_UNAVAILABLE'
  | 'HEVC_UNSUPPORTED'
  | 'I420P10_REQUIRED'
  | 'COLORSPACE_INCOMPLETE'
  | 'RPU_REQUIRED'
  | 'UNSUPPORTED_CODEC'
  | 'INVALID_COPY_LAYOUT';

export class LumaBridgeError extends Error {
  readonly code: LumaErrorCode;

  constructor(code: LumaErrorCode, message: string) {
    super(message);
    this.name = 'LumaBridgeError';
    this.code = code;
  }
}

export type ToneBridgeErrorCode =
  | 'WEBGPU_UNAVAILABLE'
  | 'WEBCODECS_UNAVAILABLE'
  | 'HEVC_UNSUPPORTED'
  | 'I420P10_REQUIRED'
  | 'COLORSPACE_INCOMPLETE'
  | 'RPU_REQUIRED'
  | 'UNSUPPORTED_CODEC'
  | 'INVALID_COPY_LAYOUT';

export class ToneBridgeError extends Error {
  readonly code: ToneBridgeErrorCode;

  constructor(code: ToneBridgeErrorCode, message: string) {
    super(message);
    this.name = 'ToneBridgeError';
    this.code = code;
  }
}

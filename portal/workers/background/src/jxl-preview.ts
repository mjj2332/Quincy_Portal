import decodeJxl, { init as initJxl } from "@jsquash/jxl/decode";
import encodeJpeg, { init as initJpeg } from "@jsquash/jpeg/encode";
import JXL_DECODER_WASM from "@jsquash/jxl/codec/dec/jxl_dec.wasm";
import JPEG_ENCODER_WASM from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";

/** The compressed preview is copied into memory only when it fits this limit. */
export const JXL_INPUT_MAX_BYTES = 4 * 1024 * 1024;
/** The encoded sibling is bounded independently of the source JXL container. */
export const JXL_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
/** A hostile JXL must not be able to make the decoder allocate an unbounded image. */
export const JXL_MAX_PIXELS = 1 * 1024 * 1024;
/** Proven upper bound for the libjxl decoder's linear memory in a Worker. */
export const JXL_DECODE_WASM_MAX_BYTES = 64 * 1024 * 1024;
/** MozJPEG needs less memory than libjxl, and is bounded separately. */
export const JPEG_ENCODE_WASM_MAX_BYTES = 32 * 1024 * 1024;
export const JXL_RGBA_BYTES_PER_PIXEL = 4;
export const JXL_MAX_RGBA_BYTES = JXL_MAX_PIXELS * JXL_RGBA_BYTES_PER_PIXEL;

export type JxlPreviewFailureCode =
  | "input-limit"
  | "invalid-dimensions"
  | "decode-failed"
  | "decoded-limit"
  | "dimension-mismatch"
  | "encode-failed"
  | "output-limit";

export class JxlPreviewError extends Error {
  readonly code: JxlPreviewFailureCode;

  constructor(code: JxlPreviewFailureCode, message: string) {
    super(message);
    this.name = "JxlPreviewError";
    this.code = code;
  }
}

export type JxlPreviewTranscode = {
  jpeg: Uint8Array;
  width: number;
  height: number;
};

type WasmInstantiate = (
  imports: WebAssembly.Imports,
  receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
) => WebAssembly.Exports;

function fail(code: JxlPreviewFailureCode, message: string): never {
  throw new JxlPreviewError(code, message);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return a WebAssembly memory facade that refuses growth beyond `maxBytes`.
 *
 * Emscripten only uses `buffer` and `grow` on the exported memory. Keeping the original
 * WebAssembly.Memory private lets us enforce the cap while preserving the generated glue's
 * memory-view refresh after a successful grow.
 */
function boundedMemory(memory: WebAssembly.Memory, maxBytes: number): { readonly buffer: ArrayBuffer; grow: (pages: number) => number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || memory.buffer.byteLength > maxBytes) {
    throw new RangeError(`WASM memory starts above the ${maxBytes}-byte cap`);
  }
  return {
    get buffer() {
      return memory.buffer;
    },
    grow(pages: number): number {
      if (!Number.isSafeInteger(pages) || pages < 0) throw new RangeError("WASM memory growth must be a non-negative page count");
      const nextBytes = memory.buffer.byteLength + pages * 64 * 1024;
      if (!Number.isSafeInteger(nextBytes) || nextBytes > maxBytes) {
        throw new RangeError(`WASM memory growth exceeds the ${maxBytes}-byte cap`);
      }
      return memory.grow(pages);
    },
  };
}

/**
 * Build the Emscripten instantiate hook used by both codecs.
 *
 * This is intentionally exported for focused tests: the important safety property is the
 * memory boundary, not merely that a module happened to decode one fixture successfully.
 */
export function instantiateBoundedWasm(wasmModule: WebAssembly.Module, memoryExportName: string, maxBytes: number): WasmInstantiate {
  return (imports, receiveInstance) => {
    const instance = new WebAssembly.Instance(wasmModule, imports);
    const exports = { ...instance.exports } as Record<string, WebAssembly.ExportValue>;
    const memory = exports[memoryExportName];
    if (!(memory instanceof WebAssembly.Memory)) throw new TypeError(`WASM module does not export memory ${memoryExportName}`);
    exports[memoryExportName] = boundedMemory(memory, maxBytes) as unknown as WebAssembly.Memory;
    // Emscripten's callback only reads `.exports`; the facade must therefore be supplied there
    // as well as returned from this hook.
    receiveInstance({ exports } as unknown as WebAssembly.Instance);
    return exports;
  };
}

function copyInput(input: Uint8Array | ArrayBuffer): ArrayBuffer {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) fail("input-limit", "JPEG XL preview is empty");
  if (bytes.byteLength > JXL_INPUT_MAX_BYTES) fail("input-limit", `JPEG XL preview exceeds ${JXL_INPUT_MAX_BYTES} bytes`);
  // A copy gives the decoder an exact ArrayBuffer even when R2 supplied a subarray or a shared
  // backing store. It also ensures the source bytes cannot change while the codec is running.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function declaredPixels(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    fail("invalid-dimensions", "JPEG XL preview dimensions must be positive safe integers");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > JXL_MAX_PIXELS) {
    fail("invalid-dimensions", `JPEG XL preview exceeds the ${JXL_MAX_PIXELS}-pixel limit`);
  }
  return pixels;
}

function decodedRgba(decoded: ImageData, width: number, height: number, pixels: number): ImageData {
  if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) || decoded.width <= 0 || decoded.height <= 0) {
    fail("decode-failed", "JPEG XL decoder returned invalid dimensions");
  }
  if (decoded.width !== width || decoded.height !== height) {
    fail("dimension-mismatch", `JPEG XL decoder returned ${decoded.width}x${decoded.height}, expected ${width}x${height}`);
  }
  const data = decoded.data;
  if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
    fail("decode-failed", "JPEG XL decoder did not return RGBA pixels");
  }
  const expectedBytes = pixels * JXL_RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > JXL_MAX_RGBA_BYTES || data.byteLength !== expectedBytes) {
    fail("decoded-limit", `JPEG XL decoded RGBA data exceeds the ${JXL_MAX_RGBA_BYTES}-byte limit or has an invalid length`);
  }
  // Do not hand the encoder a view into a decoder's mutable WASM heap. This copy is bounded by
  // the exact decoded RGBA size checked above.
  const rgba = new Uint8ClampedArray(expectedBytes);
  rgba.set(data);
  return { data: rgba, width, height } as ImageData;
}

function encodedBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!ArrayBuffer.isView(value)) return null;
  const view = value as ArrayBufferView;
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
  return copy;
}

// @jsquash's declarations expose only the browser-friendly one-argument overload. The runtime
// also accepts `(null, { instantiateWasm })`, which is required for a static Worker WASM module.
const initJxlWithWasm = initJxl as unknown as (module: WebAssembly.Module | null, options: { instantiateWasm: WasmInstantiate }) => Promise<unknown>;
const initJpegWithWasm = initJpeg as unknown as (module: WebAssembly.Module | null, options: { instantiateWasm: WasmInstantiate }) => Promise<unknown>;

// jSquash stores the active Emscripten module in module-level mutable state. Initialise each
// codec once per Worker isolate and serialize operations below; reinitialising every preview
// would temporarily retain the previous linear heap while constructing its replacement.
let jxlCodecReady: Promise<unknown> | null = null;
let jpegCodecReady: Promise<unknown> | null = null;

function ensureJxlCodec(): Promise<unknown> {
  if (!jxlCodecReady) {
    jxlCodecReady = initJxlWithWasm(null, {
      instantiateWasm: instantiateBoundedWasm(JXL_DECODER_WASM, "w", JXL_DECODE_WASM_MAX_BYTES),
    }).catch((error: unknown) => {
      jxlCodecReady = null;
      throw error;
    });
  }
  return jxlCodecReady;
}

function ensureJpegCodec(): Promise<unknown> {
  if (!jpegCodecReady) {
    jpegCodecReady = initJpegWithWasm(null, {
      instantiateWasm: instantiateBoundedWasm(JPEG_ENCODER_WASM, "C", JPEG_ENCODE_WASM_MAX_BYTES),
    }).catch((error: unknown) => {
      jpegCodecReady = null;
      throw error;
    });
  }
  return jpegCodecReady;
}

let codecQueue: Promise<void> = Promise.resolve();

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = codecQueue;
  let release!: () => void;
  codecQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Decode one bounded JXL preview and encode it as a bounded JPEG sibling. */
export async function transcodeJxlPreview(input: Uint8Array | ArrayBuffer, width: number, height: number): Promise<JxlPreviewTranscode> {
  const pixels = declaredPixels(width, height);
  return serialized(async () => {
    const inputBuffer = copyInput(input);
    let decoded: ImageData;
    try {
      await ensureJxlCodec();
      decoded = await decodeJxl(inputBuffer);
    } catch (error) {
      if (error instanceof JxlPreviewError) throw error;
      fail("decode-failed", `JPEG XL decode failed: ${detail(error)}`);
    }
    const image = decodedRgba(decoded, width, height, pixels);
    let encoded: unknown;
    try {
      await ensureJpegCodec();
      encoded = await encodeJpeg(image);
    } catch (error) {
      if (error instanceof JxlPreviewError) throw error;
      fail("encode-failed", `JPEG encoding failed: ${detail(error)}`);
    }
    const jpeg = encodedBytes(encoded);
    if (!jpeg || jpeg.byteLength < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
      fail("encode-failed", "JPEG encoder returned an invalid output");
    }
    if (jpeg.byteLength > JXL_OUTPUT_MAX_BYTES) {
      fail("output-limit", `Encoded JPEG exceeds ${JXL_OUTPUT_MAX_BYTES} bytes`);
    }
    return { jpeg, width, height };
  });
}

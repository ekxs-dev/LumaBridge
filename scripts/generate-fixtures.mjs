import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const source = process.env.LUMABRIDGE_SOURCE ?? '/path/to/input.mkv';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
  }
}

mkdirSync('tests/fixtures', { recursive: true });
mkdirSync('tests/references', { recursive: true });

run('ffmpeg', ['-y', '-hide_banner', '-ss', '00:00:10', '-i', source, '-t', '2', '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', 'tests/fixtures/dv_p5_short.mkv']);
run('ffmpeg', ['-y', '-hide_banner', '-ss', '00:00:10', '-i', source, '-frames:v', '1', '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', 'tests/fixtures/dv_p5_single_frame.mkv']);
run('ffmpeg', ['-y', '-hide_banner', '-i', 'tests/fixtures/dv_p5_short.mkv', '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', 'tests/fixtures/dv_p5_short.mp4']);
run('ffmpeg', ['-y', '-hide_banner', '-i', 'tests/fixtures/dv_p5_single_frame.mkv', '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', 'tests/fixtures/dv_p5_single_frame.mp4']);
run('ffmpeg', ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited', '-an', 'tests/fixtures/hdr10_short.mp4']);
run('cp', ['tests/fixtures/hdr10_short.mp4', 'tests/fixtures/no_rpu_hevc.mp4']);
run('ffmpeg', ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', 'tests/fixtures/bad_codec.mp4']);
run('ffmpeg', ['-y', '-hide_banner', '-i', 'tests/fixtures/dv_p5_single_frame.mkv', '-vf', 'libplacebo=w=480:h=202:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=limited:apply_dolbyvision=true:tonemapping=bt.2390:peak_detect=false,format=rgb24', '-frames:v', '1', 'tests/references/sdr_reference.png']);

const hevc = spawnSync('ffmpeg', ['-hide_banner', '-i', 'tests/fixtures/dv_p5_short.mp4', '-map', '0:v:0', '-c', 'copy', '-f', 'hevc', '-'], {
  stdio: ['ignore', 'pipe', 'ignore'],
  maxBuffer: 16 * 1024 * 1024,
}).stdout;

const starts = [];
for (let i = 0; i < hevc.length - 4; i += 1) {
  if (hevc[i] === 0 && hevc[i + 1] === 0 && hevc[i + 2] === 1) starts.push({ offset: i, prefix: 3 });
  else if (hevc[i] === 0 && hevc[i + 1] === 0 && hevc[i + 2] === 0 && hevc[i + 3] === 1) starts.push({ offset: i, prefix: 4 });
}

const nalUnitCounts = {};
const rpuNalUnits = [];
for (let i = 0; i < starts.length; i += 1) {
  const payloadStart = starts[i].offset + starts[i].prefix;
  const payloadEnd = i + 1 < starts.length ? starts[i + 1].offset : hevc.length;
  if (payloadStart + 2 > payloadEnd) continue;
  const type = (hevc[payloadStart] >> 1) & 0x3f;
  nalUnitCounts[type] = (nalUnitCounts[type] ?? 0) + 1;
  if (type === 62) rpuNalUnits.push({ index: rpuNalUnits.length, nalType: type, offset: payloadStart, size: payloadEnd - payloadStart });
}

writeFileSync('tests/references/rpu_reference.json', `${JSON.stringify({
  source: 'tests/fixtures/dv_p5_short.mp4',
  generatedBy: 'scripts/generate-fixtures.mjs',
  codec: 'hevc-main10-dv-profile5',
  dvProfile: 5,
  colorRange: 'full',
  expectedFrameRate: 25,
  nalUnitCounts,
  rpuCount: rpuNalUnits.length,
  firstRpuNalUnits: rpuNalUnits.slice(0, 8),
  metadataSchemaVersion: 1,
  compactMetadataFloat32Count: 276,
}, null, 2)}\n`);

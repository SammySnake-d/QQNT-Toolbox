'use strict';

const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const TARGET_SILK_SAMPLE_RATE = 24000;
const TARGET_VOICE_LOUDNESS_LUFS = -16;
const TARGET_VOICE_TRUE_PEAK_DB = -1.5;
const VOICE_WAVE_BIN_COUNT = 17;
const VOICE_WAVE_MAX_AMPLITUDE = 99;
const VOICE_WAVE_NOISE_FLOOR_DB = -60;

const AUDIO_EXTENSIONS = new Set([
    '.aac', '.ac3', '.amr', '.audio', '.eac3', '.flac', '.m4a', '.mp3', '.oga', '.ogg',
    '.opus', '.wav', '.weba', '.webm', '.wv'
]);
const VIDEO_EXTENSIONS = new Set([
    '.3g2', '.3gp', '.asf', '.avi', '.flv', '.m2ts', '.m4v', '.mkv', '.mov',
    '.mp4', '.mpeg', '.mpg', '.ogv', '.ts', '.webm', '.wmv'
]);

let silkWasm = null;
let silentSilkFramePromise = null;

function getSilkWasm() {
    if (!silkWasm) {
        silkWasm = require('silk-wasm');
    }
    return silkWasm;
}

function getToolCandidates(toolName) {
    return [
        process.env[`${toolName.toUpperCase()}_PATH`],
        process.env[`${toolName.toLowerCase()}_PATH`],
        ['ffmpeg', 'ffprobe'].includes(toolName)
            ? `C:\\Program Files\\ffmpeg\\bin\\${toolName}.exe`
            : '',
        toolName
    ].filter(Boolean);
}

async function runTool(toolName, args, options = {}) {
    for (const command of getToolCandidates(toolName)) {
        if (path.isAbsolute(command) && !fsSync.existsSync(command)) {
            continue;
        }
        try {
            return await execFile(command, args, {
                windowsHide: true,
                maxBuffer: 512 * 1024 * 1024,
                ...options
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }
            error.message = `${toolName} failed (${command}): ${error.message}`;
            throw error;
        }
    }
    throw new Error(`${toolName} was not found. Put it in PATH or set ${toolName.toUpperCase()}_PATH.`);
}

function isAudioMediaPath(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    return AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension);
}

function isVideoMediaPath(filePath) {
    return VIDEO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function detectMediaInputFormat(filePath) {
    let fd;
    try {
        fd = fsSync.openSync(filePath, 'r');
        const header = Buffer.alloc(16);
        const bytesRead = fsSync.readSync(fd, header, 0, header.length, 0);
        if (bytesRead >= 3 && header.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
        if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'fLaC') return 'flac';
        if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
        if (bytesRead >= 12 && header.subarray(0, 4).toString('latin1') === 'RIFF' &&
            header.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav';
        if (bytesRead >= 12 && header.subarray(4, 8).toString('latin1') === 'ftyp') return 'mov';
        if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'wvpk') return 'wv';
        if (bytesRead >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'matroska';
        if (bytesRead >= 4 && header.subarray(0, 4).toString('latin1') === 'ADIF') return 'aac';
        if (bytesRead >= 2 && header[0] === 0xff && (header[1] & 0xf6) === 0xf0) return 'aac';
        if (bytesRead >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 0x06) !== 0) return 'mp3';
        if (bytesRead >= 2 && header[0] === 0x0b && header[1] === 0x77) return 'ac3';
    } catch {
    } finally {
        if (fd !== undefined) {
            try {
                fsSync.closeSync(fd);
            } catch {
            }
        }
    }
    return '';
}

function getMediaInputArgs(filePath) {
    const format = detectMediaInputFormat(filePath);
    return [...(format ? ['-f', format] : []), '-i', filePath];
}

function getLosslessAudioExtractionPlan(codecName, sourceExtension = '') {
    const codec = String(codecName || '').trim().toLowerCase();
    const sourceExt = String(sourceExtension || '').toLowerCase();
    const plans = {
        aac: { extension: '.m4a', format: 'ipod' },
        alac: { extension: '.m4a', format: 'ipod' },
        mp3: { extension: '.mp3', format: 'mp3' },
        opus: { extension: '.ogg', format: 'ogg' },
        vorbis: { extension: '.ogg', format: 'ogg' },
        flac: { extension: '.flac', format: 'flac' },
        wavpack: { extension: '.wv', format: 'wv' },
        amr_nb: { extension: '.amr', format: 'amr' },
        amr_wb: { extension: '.amr', format: 'amr' },
        ac3: { extension: '.ac3', format: 'ac3' },
        eac3: { extension: '.eac3', format: 'eac3' },
        pcm_s16le: { extension: '.wav', format: 'wav' },
        pcm_s16be: { extension: '.wav', format: 'wav' },
        pcm_s24le: { extension: '.wav', format: 'wav' },
        pcm_s24be: { extension: '.wav', format: 'wav' },
        pcm_s32le: { extension: '.wav', format: 'wav' },
        pcm_s32be: { extension: '.wav', format: 'wav' }
    };
    if (plans[codec]) {
        return { ...plans[codec] };
    }
    // A source that is already an audio-only container can often be copied
    // without remuxing. For video containers use Matroska as the permissive
    // fallback; it keeps the compressed stream untouched.
    if (!VIDEO_EXTENSIONS.has(sourceExt) && AUDIO_EXTENSIONS.has(sourceExt)) {
        return { extension: sourceExt, format: '' };
    }
    return { extension: '.mka', format: 'matroska' };
}

async function probeAudioStream(inputPath) {
    const { stdout } = await runTool('ffprobe', [
        '-v', 'error',
        ...getMediaInputArgs(inputPath),
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,duration,sample_rate,channels:format=duration,format_name',
        '-of', 'json'
    ]);
    let parsed;
    try {
        parsed = JSON.parse(String(stdout || '{}'));
    } catch {
        parsed = {};
    }
    const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
    if (!stream?.codec_name) {
        throw new Error('No audio track was found in this media file.');
    }
    const streamDuration = Number(stream.duration);
    const formatDuration = Number(parsed?.format?.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0
        ? streamDuration
        : formatDuration;
    return {
        codecName: String(stream.codec_name).toLowerCase(),
        formatName: String(parsed?.format?.format_name || '').toLowerCase(),
        durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
        sampleRate: Number(stream.sample_rate) || 0,
        channels: Number(stream.channels) || 0
    };
}

async function extractAudioTrackWithoutReencoding(inputPath, options = {}) {
    if (!inputPath || !fsSync.existsSync(inputPath)) {
        throw new Error(`Media file was not found: ${inputPath}`);
    }
    const stream = options.stream || await probeAudioStream(inputPath);
    const plan = getLosslessAudioExtractionPlan(stream.codecName, path.extname(inputPath));
    const outputDir = options.outputDir || path.dirname(inputPath);
    await fs.mkdir(outputDir, { recursive: true });
    const stem = path.basename(inputPath, path.extname(inputPath))
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .slice(0, 70) || 'audio';
    const outputPath = path.join(
        outputDir,
        `${stem}.${Date.now().toString(36)}-${cryptoRandomSuffix()}${plan.extension}`
    );
    const args = [
        '-v', 'error',
        '-y',
        ...getMediaInputArgs(inputPath),
        '-map', '0:a:0',
        '-vn',
        '-c:a', 'copy',
        '-map_metadata', '-1'
    ];
    if (plan.format) {
        args.push('-f', plan.format);
    }
    args.push(outputPath);
    try {
        await runTool('ffmpeg', args);
        const stat = await fs.stat(outputPath);
        if (!stat.size) {
            throw new Error('FFmpeg produced an empty audio track.');
        }
        return {
            path: outputPath,
            extension: plan.extension,
            codecName: stream.codecName,
            durationMs: stream.durationMs,
            sourcePath: inputPath,
            reencoded: false
        };
    } catch (error) {
        await fs.unlink(outputPath).catch(() => {});
        const detail = error?.message || String(error);
        throw new Error(`The video audio track could not be extracted without re-encoding: ${detail}`);
    }
}

function cryptoRandomSuffix() {
    return Math.random().toString(36).slice(2, 10);
}

function toBufferView(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return Buffer.from(data);
}

function isSilkData(data) {
    const buffer = toBufferView(data);
    const magic = '#!SILK_V3';
    return (buffer.length >= 10 && (buffer[0] === 0x02 || buffer[0] === 0x03) && buffer.subarray(1, 10).toString('latin1') === magic) ||
        (buffer.length >= 9 && buffer.subarray(0, 9).toString('latin1') === magic);
}

function normalizeSilkData(data) {
    const buffer = toBufferView(data);
    if (!isSilkData(buffer)) {
        return null;
    }
    if (buffer[0] === 0x02) {
        return buffer;
    }
    if (buffer[0] === 0x03) {
        const normalized = Buffer.from(buffer);
        normalized[0] = 0x02;
        return normalized;
    }
    return Buffer.concat([Buffer.from([0x02]), buffer]);
}

function isSilkFile(filePath) {
    let fd;
    try {
        fd = fsSync.openSync(filePath, 'r');
        const header = Buffer.alloc(10);
        const bytesRead = fsSync.readSync(fd, header, 0, header.length, 0);
        return bytesRead >= 9 && isSilkData(header.subarray(0, bytesRead));
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try {
                fsSync.closeSync(fd);
            } catch {
            }
        }
    }
}

function isAmrFile(filePath) {
    let fd;
    try {
        fd = fsSync.openSync(filePath, 'r');
        const header = Buffer.alloc(9);
        const bytesRead = fsSync.readSync(fd, header, 0, header.length, 0);
        const magic = header.subarray(0, bytesRead).toString('latin1');
        return magic.startsWith('#!AMR\n') || magic.startsWith('#!AMR-WB\n');
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try {
                fsSync.closeSync(fd);
            } catch {
            }
        }
    }
}

function isQqNativePttFile(filePath) {
    return isSilkFile(filePath) || isAmrFile(filePath);
}

function toExactArrayBuffer(data) {
    if (data instanceof ArrayBuffer) {
        return data;
    }
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    const buffer = Buffer.from(data);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makePcm16Wav(pcmData, sampleRate, channels = 1) {
    const pcm = Buffer.from(pcmData);
    const header = Buffer.alloc(44);
    const bytesPerSample = 2;
    const byteRate = sampleRate * channels * bytesPerSample;
    const blockAlign = channels * bytesPerSample;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function calculatePcmWaveAmplitudes(pcmData, binCount = VOICE_WAVE_BIN_COUNT) {
    const pcm = Buffer.from(pcmData);
    const sampleCount = Math.floor(pcm.length / 2);
    const count = Math.max(1, Math.trunc(Number(binCount)) || VOICE_WAVE_BIN_COUNT);
    if (!sampleCount) {
        return Array(count).fill(0);
    }

    const amplitudes = [];
    for (let bin = 0; bin < count; bin += 1) {
        const start = Math.floor(bin * sampleCount / count);
        const end = Math.max(start + 1, Math.floor((bin + 1) * sampleCount / count));
        const stride = Math.max(1, Math.floor((end - start) / 4096));
        let sumSquares = 0;
        let sampled = 0;
        for (let sample = start; sample < end; sample += stride) {
            const value = pcm.readInt16LE(sample * 2);
            sumSquares += value * value;
            sampled += 1;
        }
        if (!sumSquares || !sampled) {
            amplitudes.push(0);
            continue;
        }
        const rmsRatio = Math.sqrt(sumSquares / sampled) / 32768;
        const decibels = 20 * Math.log10(rmsRatio);
        const level = Math.min(1, Math.max(0,
            (decibels - VOICE_WAVE_NOISE_FLOOR_DB) / -VOICE_WAVE_NOISE_FLOOR_DB
        ));
        amplitudes.push(Math.max(1, Math.round(level * VOICE_WAVE_MAX_AMPLITUDE)));
    }
    return amplitudes;
}

async function calculateSilkWaveAmplitudes(silkData) {
    const decoded = await decodeSilkToPcm(silkData);
    return calculatePcmWaveAmplitudes(decoded.data);
}

function getSilkFrameStart(data) {
    const buffer = toBufferView(data);
    if (buffer.length >= 10 && (buffer[0] === 0x02 || buffer[0] === 0x03) && buffer.subarray(1, 10).toString('latin1') === '#!SILK_V3') {
        return 10;
    }
    if (buffer.length >= 9 && buffer.subarray(0, 9).toString('latin1') === '#!SILK_V3') {
        return 9;
    }
    return -1;
}

function inspectSilkFrames(data) {
    const buffer = toBufferView(data);
    const frameStart = getSilkFrameStart(buffer);
    if (frameStart < 0) {
        return {
            isSilk: false,
            bytes: buffer.length
        };
    }

    let offset = frameStart;
    let frameCount = 0;
    let nextFrameSize = null;
    while (offset + 2 <= buffer.length) {
        const frameSize = buffer.readUInt16LE(offset);
        nextFrameSize = frameSize;
        if (!frameSize) {
            break;
        }
        const nextOffset = offset + 2 + frameSize;
        if (nextOffset > buffer.length) {
            return {
                isSilk: true,
                bytes: buffer.length,
                frameStart,
                frameCount,
                consumedBytes: offset,
                tailBytes: buffer.length - offset,
                nextFrameSize,
                missingBytes: nextOffset - buffer.length
            };
        }
        frameCount += 1;
        offset = nextOffset;
        nextFrameSize = null;
    }

    return {
        isSilk: true,
        bytes: buffer.length,
        frameStart,
        frameCount,
        consumedBytes: offset,
        tailBytes: buffer.length - offset,
        nextFrameSize,
        missingBytes: 0
    };
}

function estimateSilkDurationMs(data) {
    const info = inspectSilkFrames(data);
    return info.isSilk && info.frameCount > 0 ? info.frameCount * 20 : 1000;
}

function repairSilkFrames(data) {
    const buffer = toBufferView(data);
    const before = inspectSilkFrames(buffer);
    if (!before.isSilk || before.tailBytes === 0) {
        return {
            data: buffer,
            action: 'none',
            before,
            after: before
        };
    }

    if (before.missingBytes > 0 && before.missingBytes <= 2) {
        const repaired = Buffer.concat([buffer, Buffer.alloc(before.missingBytes)]);
        return {
            data: repaired,
            action: `pad:${before.missingBytes}`,
            before,
            after: inspectSilkFrames(repaired)
        };
    }

    const repaired = Buffer.from(buffer.subarray(0, before.consumedBytes));
    return {
        data: repaired,
        action: 'trim',
        before,
        after: inspectSilkFrames(repaired)
    };
}

async function encodeToSilk(inputData, sampleRate) {
    try {
        return {
            data: await getSilkWasm().encode(toExactArrayBuffer(inputData), sampleRate)
        };
    } catch (error) {
        return {
            error: `An error occurred while converting audio to silk. Details: ${ error?.message || error }`
        };
    }
}

async function createSilentSilk(durationMs) {
    const normalizedDuration = Math.max(20, Math.ceil(Number(durationMs) || 1000));
    const frameCount = Math.max(1, Math.ceil(normalizedDuration / 20));
    if (!silentSilkFramePromise) {
        silentSilkFramePromise = encodeToSilk(
            Buffer.alloc(TARGET_SILK_SAMPLE_RATE * 2),
            TARGET_SILK_SAMPLE_RATE
        ).then(silkResult => {
            if (silkResult.error) {
                throw new Error(silkResult.error);
            }
            const repaired = repairSilkFrames(silkResult.data.data);
            const frameStart = getSilkFrameStart(repaired.data);
            const frameSize = frameStart >= 0 && repaired.data.length >= frameStart + 2
                ? repaired.data.readUInt16LE(frameStart)
                : 0;
            if (!frameSize || repaired.data.length < frameStart + 2 + frameSize) {
                throw new Error('The silent Silk clock contains no valid audio frames.');
            }
            return Buffer.from(repaired.data.subarray(frameStart, frameStart + 2 + frameSize));
        }).catch(error => {
            silentSilkFramePromise = null;
            throw error;
        });
    }
    const frame = await silentSilkFramePromise;
    const header = Buffer.from('\x02#!SILK_V3', 'latin1');
    return {
        data: Buffer.concat([header, ...Array(frameCount).fill(frame)]),
        duration: frameCount * 20,
        sampleRate: TARGET_SILK_SAMPLE_RATE
    };
}

function parseLoudnessMeasurements(output) {
    const blocks = String(output || '').match(/\{[\s\S]*?\}/g) || [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        try {
            const value = JSON.parse(blocks[index]);
            const integrated = Number(value.input_i);
            const truePeak = Number(value.input_tp);
            if (Number.isFinite(integrated) && Number.isFinite(truePeak)) {
                return { integrated, truePeak };
            }
        } catch {
        }
    }
    return null;
}

async function measureMediaLoudness(mediaPath) {
    const { stderr } = await runTool('ffmpeg', [
        '-v', 'info',
        '-nostats',
        ...getMediaInputArgs(mediaPath),
        '-map', '0:a:0',
        '-vn',
        '-af', `aresample=out_chlayout=mono,loudnorm=I=${TARGET_VOICE_LOUDNESS_LUFS}:TP=${TARGET_VOICE_TRUE_PEAK_DB}:LRA=11:print_format=json`,
        '-f', 'null',
        '-'
    ]);
    return parseLoudnessMeasurements(stderr);
}

async function convertMediaToPcm24k(mediaPath) {
    const loudness = await measureMediaLoudness(mediaPath);
    const gain = loudness
        ? Math.min(
            TARGET_VOICE_LOUDNESS_LUFS - loudness.integrated,
            TARGET_VOICE_TRUE_PEAK_DB - loudness.truePeak
        )
        : 0;
    const filters = [
        'aresample=out_chlayout=mono',
        `volume=${gain.toFixed(2)}dB`,
        `aresample=${TARGET_SILK_SAMPLE_RATE}`
    ];
    const { stdout } = await runTool('ffmpeg', [
        '-v', 'error',
        '-y',
        ...getMediaInputArgs(mediaPath),
        '-map', '0:a:0',
        '-vn',
        '-af', filters.join(','),
        '-f', 's16le',
        'pipe:1'
    ], {
        encoding: 'buffer'
    });
    const pcmData = Buffer.from(stdout || Buffer.alloc(0));
    if (!pcmData.length) {
        throw new Error('No decodable audio track was found in this media file.');
    }
    return pcmData;
}

async function encodeMediaFileToSilk(mediaPath, options = {}) {
    const file = await fs.readFile(mediaPath);
    const normalizedSilk = normalizeSilkData(file);
    if (normalizedSilk) {
        const repaired = repairSilkFrames(normalizedSilk);
        if (!repaired.after?.frameCount) {
            throw new Error('The Silk file contains no valid audio frames.');
        }
        return {
            data: repaired.data,
            duration: Number(options.durationMs) || estimateSilkDurationMs(repaired.data),
            waveAmplitudes: await calculateSilkWaveAmplitudes(repaired.data),
            directSilk: true,
            sampleRate: TARGET_SILK_SAMPLE_RATE,
            silkRepair: {
                action: repaired.action,
                before: repaired.before,
                after: repaired.after
            }
        };
    }

    const inputData = await convertMediaToPcm24k(mediaPath);

    const silkResult = await encodeToSilk(inputData, TARGET_SILK_SAMPLE_RATE);
    if (silkResult.error) {
        throw new Error(silkResult.error);
    }
    const repaired = repairSilkFrames(silkResult.data.data);

    return {
        ...silkResult.data,
        data: repaired.data,
        duration: Number(silkResult.data.duration) || estimateSilkDurationMs(repaired.data),
        waveAmplitudes: calculatePcmWaveAmplitudes(inputData),
        sampleRate: TARGET_SILK_SAMPLE_RATE,
        silkRepair: {
            action: repaired.action,
            before: repaired.before,
            after: repaired.after
        }
    };
}

async function decodeSilkToPcm(silkData) {
    const normalized = normalizeSilkData(silkData);
    if (!normalized) {
        throw new Error('The input is not a Silk audio stream.');
    }
    return await getSilkWasm().decode(toExactArrayBuffer(normalized), TARGET_SILK_SAMPLE_RATE);
}

module.exports = {
    TARGET_SILK_SAMPLE_RATE,
    createSilentSilk,
    decodeSilkToPcm,
    detectMediaInputFormat,
    encodeMediaFileToSilk,
    estimateSilkDurationMs,
    extractAudioTrackWithoutReencoding,
    getLosslessAudioExtractionPlan,
    getMediaInputArgs,
    isAudioMediaPath,
    isQqNativePttFile,
    isVideoMediaPath,
    isSilkFile,
    makePcm16Wav,
    probeAudioStream,
    runTool
};
